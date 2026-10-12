import { randomUUID } from 'node:crypto'
import type { Db, QueryFn } from '../db'
import type { GatewayClient } from '../gateway/client'
import type { GatewayError as GwError } from '../gateway/client'
import { doTransition } from './accounts'
import { scheduleTaskIn } from '../workers/due-tasks'
import { emitWs } from '../ws/outbox'

// A2 出站管线：queued → accepted → sent | failed | unknown | cancelled。
// 先落库再调网关（崩溃不能出现“网关发出了、库里没记录”）；504 → unknown 由探测定案，至多重发一次。

export interface EnqueueOptions {
  groupId: string
  accountId: string
  text: string
  agentRunId?: string
  idempotencyKey?: string
  sequenceStepId?: string
}

/** 出站消息唯一入口：clientMsgId 在落库时生成（A2 红线） */
export async function enqueueOutbound(db: Db, opts: EnqueueOptions): Promise<string> {
  const clientMsgId = `cm-${randomUUID()}`
  await db.query(
    `INSERT INTO messages (group_id, direction, sender_account_id, is_own, text, sent_at,
                           delivery_status, client_msg_id, agent_run_id, idempotency_key, sequence_step_id)
     VALUES ($1, 'outbound', $2, true, $3, now(), 'queued', $4, $5, $6, $7)`,
    [opts.groupId, opts.accountId, opts.text, clientMsgId, opts.agentRunId ?? null, opts.idempotencyKey ?? null, opts.sequenceStepId ?? null],
  )
  return clientMsgId
}

export function isGwUnavailable(e: unknown): boolean {
  return (e as { name?: string }).name === 'GatewayUnavailable' ||
    ((e as GwError).status !== undefined && (e as GwError).status >= 500)
}

function gwCode(e: unknown): string {
  return (e as GwError).code ?? 'GATEWAY_ERROR'
}

function gwExtra(e: unknown): Record<string, unknown> {
  return (e as GwError).extra ?? {}
}

/** 队列 worker：每账号 FIFO 取最早一条 queued，投递并按错误表联动 */
export async function pumpOutbound(db: Db, gateway: GatewayClient): Promise<number> {
  const { rows } = await db.query<{
    id: string
    group_id: string
    client_msg_id: string
    sender_account_id: string
    text: string
    send_attempts: number
  }>(
    `SELECT DISTINCT ON (m.sender_account_id)
            m.id, m.group_id, m.client_msg_id, m.sender_account_id, m.text, m.send_attempts
       FROM messages m
       JOIN accounts a ON a.id = m.sender_account_id
       JOIN groups g ON g.id = m.group_id
      WHERE m.delivery_status = 'queued'
        AND a.status = 'online'
        AND g.status = 'active'
        AND (a.rate_limited_until IS NULL OR a.rate_limited_until <= now())
      ORDER BY m.sender_account_id, m.created_at
      LIMIT 20`,
  )
  for (const m of rows) {
    await deliverOne(db, gateway, m)
  }
  return rows.length
}

async function deliverOne(
  db: Db,
  gateway: GatewayClient,
  m: { id: string; group_id: string; client_msg_id: string; sender_account_id: string; text: string; send_attempts: number },
): Promise<void> {
  // 可能已被事件流/探测定案
  const { rows: cur } = await db.query<{ delivery_status: string }>(
    'SELECT delivery_status FROM messages WHERE id=$1',
    [m.id],
  )
  if (cur[0]?.delivery_status !== 'queued') return

  const gwGroupId = await gatewayGroupIdOf(db, m.group_id)
  if (!gwGroupId) return

  // 发起即计次（504 路径也要计数，“最多重发一次”依赖它）；占用即防并发重投
  const claimed = await db.query(
    `UPDATE messages SET send_attempts = send_attempts + 1 WHERE id=$1 AND delivery_status='queued'`,
    [m.id],
  )
  if ((claimed.rowCount ?? 0) !== 1) return

  try {
    await gateway.send(gwGroupId, m.sender_account_id, m.client_msg_id, m.text)
  } catch (e) {
    await handleSendError(db, m, e)
    return
  }
  await db.query(
    `UPDATE messages SET delivery_status='accepted', accepted_at=now(), sent_at=now()
      WHERE id=$1 AND delivery_status='queued'`,
    [m.id],
  )
}

export async function handleSendError(
  db: Db,
  m: { id: string; group_id: string; client_msg_id: string; sender_account_id: string },
  e: unknown,
): Promise<void> {
  // 504：结果未知 → unknown，由 resolveUnknown 探测定案（至多重发一次）
  if (gwCode(e) === 'NETWORK_TIMEOUT') {
    await db.query(
      `UPDATE messages SET delivery_status='unknown', unknown_since=now()
       WHERE id=$1 AND delivery_status IN ('queued','accepted')`,
      [m.id],
    )
    return
  }
  if (isGwUnavailable(e)) return // 网关整体不可用：保持 queued，下轮重试
  const code = gwCode(e)

  if (code === 'RATE_LIMITED') {
    const retryAfterSeconds = Number(gwExtra(e).retryAfterSeconds ?? 1)
    await db.withTx(async (q) => {
      // 消息保持 queued，到期按原顺序发出
      const t = await doTransition(q, {
        accountId: m.sender_account_id,
        to: 'rate_limited',
        source: 'send_error',
      })
      if (t.ok) {
        await q('UPDATE accounts SET rate_limited_until = now() + make_interval(secs => $2) WHERE id=$1', [
          m.sender_account_id,
          retryAfterSeconds,
        ])
        await scheduleTaskIn(q, 'rate_limit_expire', retryAfterSeconds * 1000, { accountId: m.sender_account_id })
      } else if (t.reason === 'idempotent_terminal' || t.reason === 'illegal') {
        // 已是 rate_limited：仅刷新 until（不算状态转移）
        await q('UPDATE accounts SET rate_limited_until = now() + make_interval(secs => $2) WHERE id=$1', [
          m.sender_account_id,
          retryAfterSeconds,
        ])
      }
    })
    return
  }

  if (code === 'ACCOUNT_SUSPENDED' || code === 'SESSION_EXPIRED') {
    await db.withTx(async (q) => {
      await markFailed(q, m.id, code)
      // 账号终态 + 全套副作用（取消其余 queued 消息等）与本次失败同事务
      await doTransition(q, {
        accountId: m.sender_account_id,
        to: code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired',
        source: 'send_error',
      })
    })
    return
  }

  if (code === 'GROUP_WRITE_FORBIDDEN') {
    await db.withTx(async (q) => {
      await q(`UPDATE messages SET delivery_status='failed', fail_code='GROUP_WRITE_FORBIDDEN'
               WHERE id=$1 AND delivery_status IN ('queued','accepted','unknown')`, [m.id])
      await markGroupUnreachable(q, m.group_id)
    })
    return
  }

  // SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE / 其它：本条 failed，账号群状态不变
  await db.withTx(async (q) => {
    await markFailed(q, m.id, code)
  })
}

export async function markFailed(q: QueryFn, messageId: string, failCode: string): Promise<void> {
  await q(
    `UPDATE messages SET delivery_status='failed', fail_code=$2
     WHERE id=$1 AND delivery_status IN ('queued','accepted','unknown')`,
    [messageId, failCode],
  )
}

/** 群不可写：unreachable + 该群 queued 出站 failed(GROUP_UNREACHABLE) + 序列 run 停止（A2 错误联动表） */
export async function markGroupUnreachable(q: QueryFn, groupId: string): Promise<void> {
  await q(`UPDATE groups SET status='unreachable' WHERE id=$1 AND status='active'`, [groupId])
  await q(
    `UPDATE messages SET delivery_status='failed', fail_code='GROUP_UNREACHABLE'
     WHERE group_id=$1 AND delivery_status IN ('queued','unknown')`,
    [groupId],
  )
  await q(`UPDATE sequence_runs SET status='stopped', updated_at=now()
           WHERE group_id=$1 AND status='running'`, [groupId])
}

async function gatewayGroupIdOf(db: Db, groupId: string): Promise<string | null> {
  const { rows } = await db.query<{ gateway_group_id: string | null }>(
    'SELECT gateway_group_id FROM groups WHERE id=$1',
    [groupId],
  )
  return rows[0]?.gateway_group_id ?? null
}

// ── 504 → unknown 定案（题面：5 秒内定案；确认没发出才允许重发一次；503 期间保持 unknown）──

export async function resolveUnknown(db: Db, gateway: GatewayClient, opts: {
  settleMs: number
  pollMs: number
}): Promise<number> {
  const { rows } = await db.query<{
    id: string
    group_id: string
    client_msg_id: string
    sender_account_id: string
    text: string
    send_attempts: number
    unknown_since: Date | null
  }>(
    `SELECT id, group_id, client_msg_id, sender_account_id, text, send_attempts, unknown_since
       FROM messages WHERE delivery_status='unknown' AND unknown_since <= now() - make_interval(secs => $1)
      LIMIT 10`,
    [opts.pollMs / 1000],
  )

  let handled = 0
  for (const m of rows) {
    const gwGroupId = await gatewayGroupIdOf(db, m.group_id)
    if (!gwGroupId) continue
    let probe: { status: number; body?: unknown }
    try {
      probe = await gateway.messageByClientId(gwGroupId, m.client_msg_id)
    } catch (e) {
      // 404 = 确认未落地；其它错误 = by-client-id 不可用：保持 unknown，重置结算窗口
      if ((e as GwError).status === 404) {
        probe = { status: 404 }
      } else {
        await db.query('UPDATE messages SET unknown_since=now(), last_probe_at=now() WHERE id=$1 AND delivery_status=$2', [m.id, 'unknown'])
        continue
      }
    }
    handled++
    if (probe.status === 200) {
      const body = probe.body as { msgId: string; sentAt: number }
      await db.withTx(async (q) => {
        const r = await q(
          `UPDATE messages SET delivery_status='sent', msg_id=$2, sent_at=to_timestamp($3/1000.0), unknown_since=NULL
           WHERE id=$1 AND delivery_status='unknown'`,
          [m.id, body.msgId, body.sentAt],
        )
        if ((r.rowCount ?? 0) > 0) await mergeReflowIntoOutbound(q, m.client_msg_id, body.msgId)
      })
      continue
    }
    // 404：确认没发出
    const { rows: fresh } = await db.query<{ unknown_since: Date | null; send_attempts: number }>(
      'SELECT unknown_since, send_attempts FROM messages WHERE id=$1 AND delivery_status=$2',
      [m.id, 'unknown'],
    )
    const unknownSince = fresh[0]?.unknown_since ? new Date(fresh[0].unknown_since).getTime() : 0
    if (Date.now() - unknownSince < opts.settleMs) continue // 结算窗口未满，继续探
    if ((fresh[0]?.send_attempts ?? 0) < 2) {
      // 确认没发出 → 允许唯一一次重发（同一 clientMsgId）
      await db.query(
        `UPDATE messages SET delivery_status='queued', unknown_since=NULL
         WHERE id=$1 AND delivery_status='unknown' AND send_attempts < 2`,
        [m.id],
      )
    } else {
      await db.withTx(async (q) => {
        await markFailed(q, m.id, 'NETWORK_TIMEOUT')
      })
    }
  }
  return handled
}

/** message 事件先于 message_sent 到达时，回流行会占用 (group_id,msg_id)；把并它并进出站行 */
export async function mergeReflowIntoOutbound(q: QueryFn, clientMsgId: string, msgId: string): Promise<void> {
  await q(
    `DELETE FROM messages
      WHERE msg_id=$2 AND direction='inbound'
        AND group_id = (SELECT group_id FROM messages WHERE client_msg_id=$1)`,
    [clientMsgId, msgId],
  )
}

// ws 事件辅助：message 处理器用
export async function emitMessageEvent(q: QueryFn, groupId: string, msgId: string, isOwn: boolean): Promise<void> {
  await emitWs(q, 'message', { groupId, msgId, isOwn })
}
