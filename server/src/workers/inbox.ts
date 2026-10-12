import type { Db } from '../db'
import { emitWs } from '../ws/outbox'
import { applyAccountTransition } from '../domain/accounts'
import { notifyMemberJoined, notifyMemberLeft } from '../domain/jobs'
import { mergeReflowIntoOutbound } from '../domain/outbound'
import type { GatewayClient } from '../gateway/client'

// 网关事件 handler 注册表：每个 handler 必须幂等（at-least-once 投递）。
export type GatewayEventHandler = (db: Db, data: Record<string, unknown>) => Promise<void>

const INCONSISTENCY_ATTEMPTS = 3

function iso(v: unknown): Date | null {
  if (typeof v === 'number') return new Date(v)
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

export function defaultHandlers(gateway?: GatewayClient): Record<string, GatewayEventHandler> {
  return {
    // 入站消息：按 (group_id, msg_id) 去重；自己的账号回流标 isOwn（A2/S3）
    message: async (db, data) => {
      const gatewayGroupId = String(data.groupId ?? '')
      const msgId = data.msgId == null ? null : String(data.msgId)
      if (!gatewayGroupId || !msgId) return
      const senderPu = data.senderPlatformUserId == null ? null : String(data.senderPlatformUserId)
      const sentAt = iso(data.sentAt) ?? new Date()
      const text = String(data.text ?? '')

      await db.withTx(async (q) => {
        const { rows: groupRows } = await q<{ id: string }>(
          'SELECT id FROM groups WHERE gateway_group_id = $1',
          [gatewayGroupId],
        )
        const group = groupRows[0]
        if (!group) return // 非我们管理的群，忽略

        const { rows: accRows } = await q<{ id: string }>(
          'SELECT id FROM accounts WHERE platform_user_id = $1',
          [senderPu],
        )
        const ownAccount = accRows[0] ?? null
        const isOwn = ownAccount != null

        // 自己的消息：出站行已存在（queued 起就在时间线里），message_sent 负责回填 msg_id；
        // 若本事件先到，插入回流行会在 message_sent 时被 mergeReflowIntoOutbound 合并
        const r = await q(
          `INSERT INTO messages (group_id, msg_id, direction, sender_platform_user_id, sender_account_id, is_own, text, sent_at)
           VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7)
           ON CONFLICT (group_id, msg_id) WHERE msg_id IS NOT NULL DO NOTHING`,
          [group.id, msgId, senderPu, ownAccount?.id ?? null, isOwn, text, sentAt],
        )
        // 出站行已占用该 msg_id（回流合并场景）：把回流行并进去，时间线保持一行
        if ((r.rowCount ?? 0) === 0) {
          const { rows: existing } = await q<{ client_msg_id: string | null; is_own: boolean }>(
            'SELECT client_msg_id, is_own FROM messages WHERE group_id=$1 AND msg_id=$2',
            [group.id, msgId],
          )
          if (existing[0]?.client_msg_id) {
            await mergeReflowIntoOutbound(q, existing[0].client_msg_id, msgId)
            return
          }
          // 重复事件（S2）：直接忽略
          return
        }
        await emitWs(q, 'message', { groupId: group.id, msgId, isOwn })
      })
    },

    // M4：回填出站行 msgId/sentAt，deliveryStatus → sent
    message_sent: async (db, data) => {
      const clientMsgId = String(data.clientMsgId ?? '')
      const msgId = data.msgId == null ? null : String(data.msgId)
      if (!clientMsgId || !msgId) return
      const sentAtMs = typeof data.sentAt === 'number' ? data.sentAt : Date.parse(String(data.sentAt))
      await db.withTx(async (q) => {
        const r = await q(
          `UPDATE messages SET delivery_status='sent', msg_id=$2, sent_at=to_timestamp($3/1000.0), unknown_since=NULL
           WHERE client_msg_id=$1 AND delivery_status IN ('queued','accepted','unknown') AND msg_id IS NULL`,
          [clientMsgId, msgId, Number.isNaN(sentAtMs) ? Date.now() : sentAtMs],
        )
        if ((r.rowCount ?? 0) === 0) {
          // 出站行可能已有 msg_id（消息事件先到并占位）——确认已 sent 即可
          await q(`UPDATE messages SET delivery_status='sent', unknown_since=NULL
                   WHERE client_msg_id=$1 AND delivery_status IN ('queued','accepted','unknown')`, [clientMsgId])
          return
        }
        // 若回流行先占了 (group_id,msg_id)：并入出站行，保证一条消息一行
        await mergeReflowIntoOutbound(q, clientMsgId, msgId)
      })
    },

    // M4：deliveryStatus → failed + failCode
    message_failed: async (db, data) => {
      const clientMsgId = String(data.clientMsgId ?? '')
      const code = String(data.code ?? 'UNKNOWN')
      if (!clientMsgId) return
      await db.query(
        `UPDATE messages SET delivery_status='failed', fail_code=$2
         WHERE client_msg_id=$1 AND delivery_status IN ('queued','accepted','unknown')`,
        [clientMsgId, code],
      )
    },
    // M3：写成员表 + 唤醒建群 job / 删成员表
    member_joined: async (db, data) => {
      if (!gateway) return
      await notifyMemberJoined(db, String(data.groupId ?? ''), String(data.platformUserId ?? ''), gateway)
    },
    member_left: async (db, data) => {
      await notifyMemberLeft(db, String(data.groupId ?? ''), String(data.platformUserId ?? ''))
    },
    // A1：网关推账号终态 → 与操作员/发送错误同一条转移路径（副作用一致、终态幂等）
    account_status: async (db, data) => {
      const accountId = String(data.accountId ?? '')
      const status = String(data.status ?? '')
      if (status !== 'suspended' && status !== 'session_expired') return
      await applyAccountTransition(db, { accountId, to: status, source: 'gateway_event' })
    },
  }
}

export interface ProcessResult {
  processed: number
  failed: number
}

/** 按 eventId 顺序处理未处理事件；单事件失败不阻塞后续（attempts+1 留待重试，≥3 次推 inconsistency）。 */
export async function processPendingInbox(
  db: Db,
  handlers: Record<string, GatewayEventHandler>,
  limit = 50,
): Promise<ProcessResult> {
  const { rows } = await db.query<{
    event_id: number
    type: string
    payload: Record<string, unknown>
    attempts: number
  }>(
    `SELECT event_id, type, payload, attempts FROM gateway_events
     WHERE processed_at IS NULL ORDER BY event_id LIMIT $1`,
    [limit],
  )

  let processed = 0
  let failed = 0
  for (const row of rows) {
    const handler = handlers[row.type]
    try {
      if (!handler) {
        // 未知类型：记录后标记完成（不无限重试）
        await db.query('UPDATE gateway_events SET processed_at = now(), last_error = $2 WHERE event_id = $1', [
          row.event_id,
          `unknown event type: ${row.type}`,
        ])
        processed++
        continue
      }
      await handler(db, row.payload)
      await db.query('UPDATE gateway_events SET processed_at = now() WHERE event_id = $1', [row.event_id])
      processed++
    } catch (e) {
      failed++
      const attempts = row.attempts + 1
      const message = e instanceof Error ? e.message : String(e)
      await db.query('UPDATE gateway_events SET attempts = $2, last_error = $3 WHERE event_id = $1', [
        row.event_id,
        attempts,
        message,
      ])
      if (attempts >= INCONSISTENCY_ATTEMPTS) {
        await db.withTx(async (q) => {
          await emitWs(q, 'inconsistency', {
            kind: 'inbox_process_failed',
            ref: `gateway_event:${row.event_id}`,
            message,
          })
        })
      }
    }
  }
  return { processed, failed }
}
