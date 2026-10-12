import { canTransition, isTerminal, type AccountStatus } from '@mhub/shared'
import type { Db, QueryFn } from '../db'
import { emitWs } from '../ws/outbox'

// A1 状态机唯一入口：三条来源（操作员 / 网关事件 / 发送错误）都走这里，
// 终态副作用（移出群、取消排队消息、序列步骤 skipped、WS 事件）与状态更新同事务。
export type TransitionSource = 'operator' | 'gateway_event' | 'send_error' | 'rate_limit_expiry'

export type TransitionResult =
  | { ok: true; from: AccountStatus; to: AccountStatus }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'illegal' }
  | { ok: false; reason: 'cas_conflict' }
  | { ok: false; reason: 'idempotent_terminal' }

export interface TransitionInput {
  accountId: string
  to: AccountStatus
  source: TransitionSource
  /** operator 必填（题面：expectedFrom 必填） */
  expectedFrom?: AccountStatus
}

export async function applyAccountTransition(db: Db, input: TransitionInput): Promise<TransitionResult> {
  return db.withTx(async (q) => doTransition(q, input))
}

/** 事务内版本：供发送错误处理等已在事务中的调用方复用 */
export async function doTransition(q: QueryFn, input: TransitionInput): Promise<TransitionResult> {
  const { accountId, to, source, expectedFrom } = input
  const { rows } = await q<{ status: AccountStatus }>(
    'SELECT status FROM accounts WHERE id = $1 FOR UPDATE',
    [accountId],
  )
  const current = rows[0]?.status
  if (!current) return { ok: false, reason: 'not_found' }

  if (expectedFrom !== undefined && expectedFrom !== current) {
    return { ok: false, reason: 'cas_conflict' }
  }

  // 终态重复进入：静默忽略（操作员显式同态转移仍算 ILLEGAL_TRANSITION，题面"包括同状态到同状态"）
  if (isTerminal(current) && current === to && source !== 'operator') {
    return { ok: false, reason: 'idempotent_terminal' }
  }
  if (isTerminal(current) && source === 'operator') {
    // 终态无出边；同态转移也拒绝（题面：包括同状态到同状态）
    return { ok: false, reason: 'illegal' }
  }
  if (current === to) return { ok: false, reason: 'illegal' }
  if (!canTransition(current, to)) return { ok: false, reason: 'illegal' }

  const r = await q(
    'UPDATE accounts SET status = $2, last_transition_at = now() WHERE id = $1 AND status = $3',
    [accountId, to, current],
  )
  if (r.rowCount !== 1) return { ok: false, reason: 'cas_conflict' }

  if (isTerminal(to)) {
    await applyTerminalSideEffects(q, accountId)
    await emitWs(q, 'account_terminal', { accountId, status: to })
  }
  // 状态事件在状态已保存的同事务里入 outbox（A1：推给前端的状态必须对应已保存状态）
  await emitWs(q, 'account_status_changed', { accountId, from: current, to })
  return { ok: true, from: current, to }
}

async function applyTerminalSideEffects(q: QueryFn, accountId: string): Promise<void> {
  await q('DELETE FROM group_members WHERE account_id = $1', [accountId])
  await q(
    `UPDATE messages SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL'
     WHERE sender_account_id = $1 AND delivery_status IN ('queued','unknown')`,
    [accountId],
  )
  await q(
    `UPDATE sequence_steps SET status = 'skipped', sent_at = now()
     WHERE account_id = $1 AND status IN ('pending','accepted')`,
    [accountId],
  )
}

/** 终态后果的幂等补偿：处理"终态事件到达晚于副作用"或崩溃残留的兜底（如收到 suspended 但成员仍在） */
export async function reconcileTerminalSideEffects(db: Db, accountId: string): Promise<void> {
  await db.withTx(async (q) => {
    const { rows } = await q<{ status: AccountStatus }>('SELECT status FROM accounts WHERE id = $1', [accountId])
    if (rows[0] && isTerminal(rows[0].status)) {
      await applyTerminalSideEffects(q, accountId)
    }
  })
}
