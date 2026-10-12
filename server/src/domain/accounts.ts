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
  const affectedSequenceRuns: string[] = []
  const result = await db.withTx(async (q) => doTransition(q, input, affectedSequenceRuns))
  // 终态跳过的序列步骤需要在事务外续链（依赖序列域的排期逻辑）
  if (result.ok && isTerminal(result.to) && affectedSequenceRuns.length > 0) {
    const { chainSequenceAfterTerminalSkip } = await import('./sequence')
    await chainSequenceAfterTerminalSkip(db, affectedSequenceRuns)
  }
  return result
}

/** 事务内版本：供发送错误处理等已在事务中的调用方复用 */
export async function doTransition(q: QueryFn, input: TransitionInput, affectedSequenceRuns?: string[]): Promise<TransitionResult> {
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
    await applyTerminalSideEffects(q, accountId, affectedSequenceRuns)
    await emitWs(q, 'account_terminal', { accountId, status: to })
  }
  // 状态事件在状态已保存的同事务里入 outbox（A1：推给前端的状态必须对应已保存状态）
  await emitWs(q, 'account_status_changed', { accountId, from: current, to })
  return { ok: true, from: current, to }
}

async function applyTerminalSideEffects(q: QueryFn, accountId: string, affectedSequenceRuns?: string[]): Promise<void> {
  await q('DELETE FROM group_members WHERE account_id = $1', [accountId])
  await q(
    `UPDATE messages SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL'
     WHERE sender_account_id = $1 AND delivery_status IN ('queued','unknown')`,
    [accountId],
  )
  // 记下受影响 run，事务提交后续链（A1：对应序列步骤变为 skipped，进度照常推进）
  if (affectedSequenceRuns) {
    const { rows } = await q<{ run_id: string }>(
      `SELECT DISTINCT run_id FROM sequence_steps WHERE account_id=$1 AND status IN ('pending','accepted')`,
      [accountId],
    )
    affectedSequenceRuns.push(...rows.map((r) => r.run_id))
  }
  await q(
    `UPDATE sequence_steps SET status = 'skipped', sent_at = now()
     WHERE account_id = $1 AND status IN ('pending','accepted')`,
    [accountId],
  )
}

