import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { login, pollUntil, setupRuntimeTest, teardownRuntimeTest, type RuntimeCtx } from '../helpers'

// A5.8 恢复：run 进行中任意时刻重启，从中断处继续；已产生外部效果的调用不重放、不记失败。
// 用手工布置的"崩溃中间态"（pending_action 指向已 accepted 的消息）做确定性验证。
let ctx: RuntimeCtx
let adminToken = ''
let groupId = ''

const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

beforeAll(async () => {
  ctx = await setupRuntimeTest()
  adminToken = await login(ctx, 'admin', 'admin')
  for (const id of ['acc-alpha', 'acc-bravo', 'acc-charlie']) {
    await ctx.app.inject({ method: 'POST', url: `/api/accounts/${id}/connect`, ...req(adminToken) })
  }
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/groups',
    payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo', 'acc-charlie'] },
    ...req(adminToken),
  })
  const { jobId } = res.json() as { jobId: string }
  await pollUntil(async () => {
    const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
    return j.json().status === 'finished' ? true : null
  }, { timeoutMs: 8000 })
  const g = await ctx.app.inject({ method: 'GET', url: '/api/groups', ...req(adminToken) })
  groupId = (g.json() as Array<{ id: string }>)[0]!.id
  await ctx.app.inject({ method: 'PATCH', url: `/api/groups/${groupId}`, payload: { agentEnabled: true }, ...req(adminToken) })
}, 30_000)

afterAll(async () => {
  await teardownRuntimeTest(ctx)
})

it('崩溃中间态恢复：pending_action 的 send 不重发，run 正常走完', async () => {
  const sendBefore = (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters.send ?? 0
  const clientMsgId = `cm-crash-${Date.now()}`

  // 崩溃前的消息：已 accepted（网关已受理），run 挂在 pending_action
  const msg = await ctx.db.query<{ id: string }>(
    `INSERT INTO messages (group_id, direction, sender_account_id, is_own, text, sent_at, delivery_status, client_msg_id, accepted_at)
     VALUES ($1, 'outbound', 'acc-charlie', true, 'crash 恢复的消息', now(), 'accepted', $2, now())
     RETURNING id`,
    [groupId, clientMsgId],
  )
  const messageId = msg.rows[0]!.id
  const runId = randomUUID()
  const history = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_crash', name: 'send_message', input: { text: 'crash 恢复的消息', idempotency_key: 'k-crash' } }] },
  ]
  await ctx.db.query(
    `INSERT INTO agent_runs (id, group_id, status, trigger, history, step_count, deadline_at, pending_action)
     VALUES ($1, $2, 'running', $3::jsonb, $4::jsonb, 0, now() + make_interval(secs => 60), $5::jsonb)`,
    [
      runId,
      groupId,
      JSON.stringify({ groupId: 'g-1', triggerMessages: [{ msgId: 'ext-crash', senderPlatformUserId: 'pu-external', text: 'trigger', sentAt: new Date().toISOString() }], policy: { autoKickEnabled: false }, ownPlatformUserIds: [] }),
      JSON.stringify(history),
      JSON.stringify({ toolUseId: 'tu_crash', name: 'send_message', input: { text: 'crash 恢复的消息', idempotency_key: 'k-crash' }, idempotencyKey: 'k-crash', messageId, phase: 'executing' }),
    ],
  )
  await ctx.db.query('INSERT INTO agent_idempotency (run_id, idempotency_key, message_id) VALUES ($1,$2,$3)', [runId, 'k-crash', messageId])
  await ctx.db.query(
    `INSERT INTO agent_steps (run_id, idx, kind, tool_use_id, name, input) VALUES ($1, 0, 'tool_use', 'tu_crash', 'send_message', $2::jsonb)`,
    [runId, JSON.stringify({ text: 'crash 恢复的消息', idempotency_key: 'k-crash' })],
  )

  // 预置该 run 的后续脚本：恢复 reconcile 后直接结束（隔离默认链的真实发送）
  await ctx.agentMock.ctl('script', { runId, steps: [{ type: 'end_turn', text: 'resume done' }] })
  // 恢复的 runtime 轮询器拾起该 run：reconcile → 等 accepted 结果 → 继续默认链 → 结束
  const detail = await pollUntil(async () => {
    const r = await ctx.app.inject({ method: 'GET', url: `/api/agent-runs/${runId}`, ...req(adminToken) })
    const body = r.json() as { status: string; endReason: string | null; summary: string | null; steps: Array<Record<string, unknown>> }
    return body.status === 'finished' ? body : null
  }, { timeoutMs: 15000, intervalMs: 100 })

  expect(detail.endReason).toBe('final')
  expect(detail.summary).toBe('resume done')
  const sendStep = detail.steps.find((s) => s.toolUseId === 'tu_crash')!
  expect(sendStep).toBeTruthy()
  expect(String(sendStep.resultSummary)).toContain('"accepted"') // 恢复自消息当前状态，未重发
  expect(String(sendStep.resultSummary)).not.toContain('is_error')

  const sendAfter = (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters.send ?? 0
  expect(sendAfter).toBe(sendBefore) // 网关没有收到第二次 send
})
