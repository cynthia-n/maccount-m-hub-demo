import type { Db, QueryFn } from '../db'

export type DueTaskHandler = (db: Db, payload: Record<string, unknown>) => Promise<void>

export function scheduleTask(
  q: QueryFn,
  kind: string,
  runAt: Date,
  payload: Record<string, unknown> = {},
): Promise<void> {
  return q('INSERT INTO due_tasks (kind, run_at, payload) VALUES ($1, $2, $3::jsonb)', [
    kind,
    runAt,
    JSON.stringify(payload),
  ]).then(() => undefined)
}

export function scheduleTaskIn(q: QueryFn, kind: string, delayMs: number, payload: Record<string, unknown> = {}) {
  return scheduleTask(q, kind, new Date(Date.now() + delayMs), payload)
}

const MAX_ATTEMPTS = 3

/** 捞取到期任务并执行（FOR UPDATE SKIP LOCKED 防多实例重复消费）。失败退避重试，3 次后放弃。 */
export async function runDueTasks(db: Db, handlers: Record<string, DueTaskHandler>): Promise<number> {
  const { rows } = await db.query<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number }>(
    `UPDATE due_tasks SET status = 'running', claimed_at = now()
     WHERE id IN (
       SELECT id FROM due_tasks
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at
       LIMIT 20
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, payload, attempts`,
  )
  let ran = 0
  for (const task of rows) {
    ran++
    const handler = handlers[task.kind]
    try {
      if (!handler) throw new Error(`no handler for kind ${task.kind}`)
      await handler(db, task.payload ?? {})
      await db.query("UPDATE due_tasks SET status = 'done' WHERE id = $1", [task.id])
    } catch (e) {
      const attempts = task.attempts + 1
      const message = e instanceof Error ? e.message : String(e)
      if (attempts >= MAX_ATTEMPTS) {
        await db.query("UPDATE due_tasks SET status = 'cancelled', attempts = $2, last_error = $3 WHERE id = $1", [
          task.id,
          attempts,
          message,
        ])
      } else {
        // 退避 200ms * 2^attempts
        await db.query(
          "UPDATE due_tasks SET status = 'pending', attempts = $2, last_error = $3, run_at = now() + make_interval(secs => $4) WHERE id = $1",
          [task.id, attempts, message, (200 * 2 ** attempts) / 1000],
        )
      }
    }
  }
  return ran
}
