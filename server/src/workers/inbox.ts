import type { Db } from '../db'
import { emitWs } from '../ws/outbox'
import { applyAccountTransition } from '../domain/accounts'

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

export function defaultHandlers(): Record<string, GatewayEventHandler> {
  return {
    // 入站消息：按 (group_id, msg_id) 去重；自己的账号回流标 isOwn（A2）
    message: async (db, data) => {
      const gatewayGroupId = String(data.groupId ?? '')
      const msgId = data.msgId == null ? null : String(data.msgId)
      if (!gatewayGroupId || !msgId) return
      const { rows: groupRows } = await db.query<{ id: string }>(
        'SELECT id FROM groups WHERE gateway_group_id = $1',
        [gatewayGroupId],
      )
      const group = groupRows[0]
      if (!group) return // 非我们管理的群（或建群尚未落库），忽略

      const senderPu = data.senderPlatformUserId == null ? null : String(data.senderPlatformUserId)
      const { rows: accRows } = await db.query<{ id: string }>(
        'SELECT id FROM accounts WHERE platform_user_id = $1',
        [senderPu],
      )
      const ownAccount = accRows[0] ?? null
      const sentAt = iso(data.sentAt) ?? new Date()
      const text = String(data.text ?? '')

      // 回流合并：自己的出站消息已在表里（按 client_msg_id），这里不匹配时才插入新行；
      // 出站行回填由 message_sent 处理器负责（M4），此处仅防重复插入
      await db.query(
        `INSERT INTO messages (group_id, msg_id, direction, sender_platform_user_id, sender_account_id, is_own, text, sent_at)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7)
         ON CONFLICT (group_id, msg_id) WHERE msg_id IS NOT NULL DO NOTHING`,
        [group.id, msgId, senderPu, ownAccount?.id ?? null, ownAccount != null, text, sentAt],
      )
    },

    // 以下在后续里程碑接入：
    message_sent: async () => {}, // M4：回填出站行 msgId/sentAt，deliveryStatus → sent
    message_failed: async () => {}, // M4：deliveryStatus → failed + failCode
    member_joined: async () => {}, // M3：写成员表、唤醒建群 job
    member_left: async () => {}, // M3/M6：删成员表
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
