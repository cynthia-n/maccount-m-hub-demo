import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError, ErrorCode, renderText, resolveSequence, type SequenceDef } from '@mhub/shared'
import type { Db, QueryFn } from '../db'
import { scheduleTaskIn } from '../workers/due-tasks'
import { emitWs } from '../ws/outbox'

// B1 定时序列：预检(静态解析)→ 逐步链式排期（第 n 步锚定第 n-1 步"发出"= message_sent 时刻）
// 跳过的步骤以跳过时刻视为发出。变量覆盖链与溯源见 resolveSequence。

export const sequenceDefSchema = z.object({
  name: z.string().min(1),
  steps: z
    .array(
      z.object({
        index: z.number().int().positive(),
        accountRole: z.enum(['admin', 'member']),
        text: z.string().min(1),
        delaySeconds: z.number().nonnegative(),
      }),
    )
    .min(1),
})
export type { SequenceDef }

export const sequenceRunBody = z.object({
  sequenceId: z.string().uuid(),
  vars: z.record(z.string()).default({}),
  stepVars: z.record(z.record(z.string())).default({}),
})

export async function createSequence(db: Db, def: SequenceDef): Promise<string> {
  const steps = [...def.steps].sort((a, b) => a.index - b.index)
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO sequences (name, definition) VALUES ($1, $2::jsonb) RETURNING id',
    [def.name, JSON.stringify({ name: def.name, steps })],
  )
  return rows[0]!.id
}

/** 启动：先预检后落库（S8：预检失败不留任何记录）；部分唯一索引兜底 S7 */
export async function startSequenceRun(
  db: Db,
  groupId: string,
  body: { sequenceId: string; vars: Record<string, string>; stepVars: Record<string, Record<string, string>> },
): Promise<{ runId: string }> {
  const { rows: seqs } = await db.query<{ definition: SequenceDef }>(
    'SELECT definition FROM sequences WHERE id=$1',
    [body.sequenceId],
  )
  const def = seqs[0]?.definition
  if (!def) throw new AppError(404, 'SEQUENCE_NOT_FOUND', '序列不存在')

  const pre = resolveSequence(def.steps, body.vars, body.stepVars)
  if (!pre.ok) {
    throw new AppError(422, ErrorCode.UNRESOLVED_PLACEHOLDER, `占位符 {${pre.key}} 无法解析`, {
      stepIndex: pre.stepIndex,
      key: pre.key,
    })
  }

  return db.withTx(async (q) => {
    const runId = randomUUID()
    try {
      await q(
        `INSERT INTO sequence_runs (id, group_id, sequence_id, status, vars, step_vars)
         VALUES ($1, $2, $3, 'running', $4::jsonb, $5::jsonb)`,
        [runId, groupId, body.sequenceId, JSON.stringify(body.vars), JSON.stringify(body.stepVars)],
      )
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new AppError(409, ErrorCode.SEQUENCE_ALREADY_RUNNING, '该群已有运行中的序列')
      }
      throw e
    }
    const steps = [...def.steps].sort((a, b) => a.index - b.index)
    const first = steps[0]!
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      await q(
        `INSERT INTO sequence_steps (id, run_id, step_index, status, resolved_vars, var_sources)
         VALUES ($1, $2, $3, 'pending', $4::jsonb, $5::jsonb)`,
        [randomUUID(), runId, s.index, JSON.stringify(pre.perStep[i]!.resolved), JSON.stringify(pre.perStep[i]!.sources)],
      )
    }
    await q('UPDATE sequence_runs SET current_step_index=$2 WHERE id=$1', [runId, first.index])
    await scheduleTaskIn(q, 'sequence_step', first.delaySeconds * 1000, { runId, stepIndex: first.index })
    return { runId }
  })
}

export interface SequenceStepRow {
  id: string
  run_id: string
  step_index: number
  status: string
  account_id: string | null
  scheduled_at: Date | null
  sent_at: Date | null
  client_msg_id: string | null
  resolved_vars: Record<string, string>
  var_sources: Record<string, string>
}

async function loadRunSteps(db: Db, runId: string) {
  const { rows: runs } = await db.query<{
    id: string
    group_id: string
    status: string
    vars: Record<string, string>
    step_vars: Record<string, Record<string, string>>
  }>('SELECT id, group_id, status, vars, step_vars FROM sequence_runs WHERE id=$1', [runId])
  const run = runs[0]
  if (!run) return null
  const { rows: steps } = await db.query<SequenceStepRow>(
    'SELECT id, run_id, step_index, status, account_id, scheduled_at, sent_at, client_msg_id, resolved_vars, var_sources FROM sequence_steps WHERE run_id=$1 ORDER BY step_index',
    [runId],
  )
  const { rows: defs } = await db.query<{ definition: SequenceDef }>(
    'SELECT s.definition FROM sequences s JOIN sequence_runs r ON r.sequence_id = s.id WHERE r.id=$1',
    [runId],
  )
  return { run, steps, def: defs[0]?.definition }
}

/** due task：执行一个步骤（选账号 → 发或跳过） */
export async function runSequenceStep(db: Db, runId: string, stepIndex: number): Promise<void> {
  const loaded = await loadRunSteps(db, runId)
  if (!loaded || loaded.run.status !== 'running') return
  const { run, steps, def } = loaded
  const step = steps.find((s) => s.step_index === stepIndex)
  const defStep = def?.steps.find((s) => s.index === stepIndex)
  if (!step || !defStep || step.status !== 'pending') return

  const { rows: grp } = await db.query<{ status: string }>('SELECT status FROM groups WHERE id=$1', [run.group_id])
  if (grp[0]?.status !== 'active') return // 已 unreachable：run 已被标 stopped

  const account = await pickStepAccount(db, run.group_id, defStep.accountRole)
  if (!account) {
    // 没有匹配账号：skipped + 时间戳，链继续
    await db.withTx(async (q) => {
      await q(`UPDATE sequence_steps SET status='skipped', sent_at=now() WHERE id=$1 AND status='pending'`, [step.id])
      await scheduleNextStep(q, db, runId, stepIndex)
    })
    return
  }
  // rate_limited 的账号不算没有：顺延到限流结束（由调用方过滤，这里兜底再查一次）
  const { rows: acc } = await db.query<{ status: string; rate_limited_until: Date | null }>(
    'SELECT status, rate_limited_until FROM accounts WHERE id=$1',
    [account],
  )
  if (acc[0]?.status !== 'online') {
    if (acc[0]?.status === 'rate_limited' && acc[0].rate_limited_until) {
      const waitMs = Math.max(200, new Date(acc[0].rate_limited_until).getTime() - Date.now() + 100)
      await db.withTx((q) => scheduleTaskIn(q, 'sequence_step', waitMs, { runId, stepIndex }))
      return
    }
    // 变 offline/终态：视为没有匹配账号 → skipped
    await db.withTx(async (q) => {
      await q(`UPDATE sequence_steps SET status='skipped', sent_at=now() WHERE id=$1 AND status='pending'`, [step.id])
      await scheduleNextStep(q, db, runId, stepIndex)
    })
    return
  }

  // 发送：文本占位符解析 + 出站管线接管（accepted/sent 由管线回填，链在 message_sent 时续）
  const text = renderText(defStep.text, step.resolved_vars)
  const clientMsgId = randomUUID()
  await db.withTx(async (q) => {
    await q(
      `INSERT INTO messages (group_id, direction, sender_account_id, is_own, text, sent_at, delivery_status, client_msg_id, sequence_step_id)
       VALUES ($1, 'outbound', $2, true, $3, now(), 'queued', $4, $5)`,
      [run.group_id, account, text, clientMsgId, step.id],
    )
    await q(`UPDATE sequence_steps SET status='accepted', account_id=$2, client_msg_id=$3, scheduled_at=now() WHERE id=$1`, [step.id, account, clientMsgId])
    await q('UPDATE sequence_runs SET current_step_index=$2, updated_at=now() WHERE id=$1', [runId, stepIndex])
  })
  // 泵会自动捞起 queued（pumpOutbound 每 tick 扫描）
}

/** 选账号：admin 步 role=admin 优先、creator 次之；member 步 role=member 按 accountId 字典序 */
async function pickStepAccount(db: Db, groupId: string, role: 'admin' | 'member'): Promise<string | null> {
  if (role === 'admin') {
    for (const r of ['admin', 'creator'] as const) {
      const { rows } = await db.query<{ account_id: string }>(
        `SELECT gm.account_id FROM group_members gm JOIN accounts a ON a.id=gm.account_id
         WHERE gm.group_id=$1 AND gm.role=$2 AND a.status='online' ORDER BY gm.account_id LIMIT 1`,
        [groupId, r],
      )
      if (rows[0]) return rows[0].account_id
    }
    return null
  }
  const { rows } = await db.query<{ account_id: string }>(
    `SELECT gm.account_id FROM group_members gm JOIN accounts a ON a.id=gm.account_id
     WHERE gm.group_id=$1 AND gm.role='member' AND a.status='online' ORDER BY gm.account_id LIMIT 1`,
    [groupId],
  )
  return rows[0]?.account_id ?? null
}

/** message_sent 到达：步骤 sent → 以"发出时刻 + 下一步 delay"排下一步 */
export async function completeSequenceStepOnSent(db: Db, sequenceStepId: string, sentAt: Date): Promise<void> {
  const { rows } = await db.query<{ run_id: string; step_index: number; status: string }>(
    'SELECT run_id, step_index, status FROM sequence_steps WHERE id=$1',
    [sequenceStepId],
  )
  const step = rows[0]
  if (!step || step.status !== 'accepted') return
  await db.withTx(async (q) => {
    const r = await q(
      `UPDATE sequence_steps SET status='sent', sent_at=$2 WHERE id=$1 AND status='accepted'`,
      [sequenceStepId, sentAt],
    )
    if ((r.rowCount ?? 0) === 0) return
    await scheduleNextStep(q, db, step.run_id, step.step_index, sentAt)
  })
}

async function scheduleNextStep(
  q: QueryFn,
  db: Db,
  runId: string,
  currentIndex: number,
  from?: Date,
): Promise<void> {
  const loaded = await loadRunSteps(db, runId)
  if (!loaded) return
  const { steps, def } = loaded
  const next = steps.find((s) => s.step_index > currentIndex && s.status === 'pending')
  if (!next) {
    if (steps.every((s) => s.status !== 'pending')) {
      const { rows: r } = await q<{ group_id: string }>('SELECT group_id FROM sequence_runs WHERE id=$1', [runId])
      await q(`UPDATE sequence_runs SET status='finished', updated_at=now() WHERE id=$1 AND status='running'`, [runId])
      if (r[0]) await emitWs(q, 'sequence_run', { runId, groupId: r[0].group_id, status: 'finished', currentStepIndex: null })
    }
    return
  }
  const defStep = def?.steps.find((s) => s.index === next.step_index)
  const delayMs = Math.max(0, (defStep?.delaySeconds ?? 0) * 1000)
  await q('UPDATE sequence_runs SET current_step_index=$2, updated_at=now() WHERE id=$1', [runId, next.step_index])
  // 排期锚点：前一步"发出"（message_sent）或跳过时刻；due_tasks 持久化，重启天然保留
  await scheduleTaskIn(q, 'sequence_step', delayMs, { runId, stepIndex: next.step_index })
  void from
}

/** 重启重排（B1）：每个 running run 只把"最早的已过期步骤"重排到 now+delay；后续仍链式 */
export async function rescheduleExpiredSequenceSteps(db: Db): Promise<void> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM sequence_runs WHERE status='running'`)
  for (const r of rows) {
    await db.withTx(async (q) => {
      const { rows: due } = await q<{ id: string; run_at: Date; payload: { stepIndex?: number } }>(
        `SELECT id, run_at, payload FROM due_tasks
         WHERE kind='sequence_step' AND status IN ('pending','running') AND payload->>'runId'=$1
         ORDER BY run_at LIMIT 1`,
        [r.id],
      )
      const task = due[0]
      if (!task) return
      if (new Date(task.run_at).getTime() > Date.now()) return // 未过期：不动
      const stepIndex = task.payload?.stepIndex
      const { rows: st } = await q<{ step_index: number }>(
        `SELECT step_index FROM sequence_steps WHERE run_id=$1 AND status='pending' ORDER BY step_index LIMIT 1`,
        [r.id],
      )
      const target = st[0]?.step_index
      if (target === undefined) return
      const delaySec = await stepDelay(db, r.id, target)
      // 只重排这一个已过期任务；后续步骤由链式推进
      await q(`UPDATE due_tasks SET run_at = now() + make_interval(secs => $2) WHERE id=$1`, [task.id, delaySec])
      void stepIndex
    })
  }
}

/** 该步骤的 delaySeconds（原样返回，秒） */
async function stepDelay(db: Db, runId: string, stepIndex: number): Promise<number> {
  const loaded = await loadRunSteps(db, runId)
  const defStep = loaded?.def?.steps.find((s) => s.index === stepIndex)
  return Math.max(0, defStep?.delaySeconds ?? 0)
}
