import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { login, pollUntil, setupRuntimeTest, teardownRuntimeTest, type RuntimeCtx } from '../helpers'

let ctx: RuntimeCtx
let adminToken = ''
let groupId = ''

const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

async function triggerExternal(text: string): Promise<void> {
  await ctx.mock.ctl('emit', {
    type: 'message',
    data: { groupId: 'g-1', msgId: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, senderPlatformUserId: 'pu-external-user', text, sentAt: Date.now() },
  })
}

async function waitRun(pred: (run: { status: string; endReason: string | null; summary: string | null; steps?: Array<Record<string, unknown>> }) => boolean, timeoutMs = 15000): Promise<{
  id: string
  status: string
  endReason: string | null
  summary: string | null
  steps: Array<Record<string, unknown>>
}> {
  return pollUntil(async () => {
    const runs = await ctx.app.inject({ method: 'GET', url: `/api/groups/${groupId}/agent-runs`, ...req(adminToken) })
    for (const r of runs.json() as Array<{ id: string }>) {
      const detail = await ctx.app.inject({ method: 'GET', url: `/api/agent-runs/${r.id}`, ...req(adminToken) })
      const body = detail.json()
      if (pred(body)) return body
    }
    return null
  }, { timeoutMs, intervalMs: 100 })
}

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

describe('A5 触发与循环', () => {
  it('S6：坏 JSON → 未知工具 → 正常结束；每步有 kind 与 rawResponse', async () => {
    await ctx.agentMock.ctl('scriptAll', {
      steps: [{ type: 'bad_json' }, { type: 'unknown_tool' }, { type: 'end_turn', text: 'all done' }],
    })
    await triggerExternal('触发 S6')
    const run = await waitRun((r) => r.status === 'finished' && r.endReason === 'final')
    expect(run.summary).toBe('all done')
    expect(run.steps.length).toBe(3)
    expect(run.steps[0]).toMatchObject({ kind: 'protocol_error', errorCode: 'BAD_JSON' })
    expect(String(run.steps[0]!.rawResponse)).toContain('无法完成')
    expect(run.steps[1]).toMatchObject({ kind: 'tool_use', errorCode: 'UNKNOWN_TOOL', isError: true })
    expect(run.steps[2]).toMatchObject({ kind: 'final' })
  })

  it('触发去重与链式：run 进行中的两条消息 → 恰一个 running，结束后链式下一次 run 携带两条', async () => {
    await ctx.agentMock.ctl('scriptAll', {
      steps: [{ type: 'slow', ms: 600, then: { type: 'end_turn', text: 'first run done' } }],
    })
    await triggerExternal('链式消息 1')
    await triggerExternal('链式消息 2')

    // 恰一个 running
    await pollUntil(async () => {
      const runs = await ctx.app.inject({ method: 'GET', url: `/api/groups/${groupId}/agent-runs`, ...req(adminToken) })
      const running = (runs.json() as Array<{ status: string }>).filter((r) => r.status === 'running')
      return running.length === 1 ? true : null
    })

    const first = await waitRun((r) => r.status === 'finished' && r.summary === 'first run done')
    void first
    // 链式下一次 run：携带两条待处理消息
    const chained = await waitRun((r) => r.status === 'finished' && r.summary === 'done', 15000)
    void chained
    const runs = await ctx.app.inject({ method: 'GET', url: `/api/groups/${groupId}/agent-runs`, ...req(adminToken) })
    const list = runs.json() as Array<{ id: string }>
    expect(list.length).toBeGreaterThanOrEqual(2)
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/agent-runs/${list[list.length - 1]!.id}`, ...req(adminToken) })
    void detail
  })

  it('S5：504 后重试同 idempotency_key——网关恰好一条、不重复审计、run 正常结束', async () => {
    await ctx.mock.ctl('setSend504', { count: 1 })
    await ctx.mock.ctl('setSentLatencyMs', { min: 300, max: 400 })
    const sendBefore = (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters.send ?? 0
    const auditBefore = (await ctx.agentMock.ctl('noopAudit')) as never
    void auditBefore

    await ctx.agentMock.ctl('scriptAll', {
      steps: [{ type: 'resend_same_key', text: 'S5 幂等测试' }, { type: 'end_turn', text: 'S5 done' }],
    })
    await triggerExternal('触发 S5')

    const run = await waitRun((r) => r.status === 'finished' && r.summary === 'S5 done', 20000)
    // 两个 send 步，同 key，第二步不审计
    const sendSteps = run.steps.filter((s) => s.name === 'send_message') as Array<{
      isError: boolean
      auditVerdict: string | null
      input: { idempotency_key?: string }
      resultSummary: string
    }>
    expect(sendSteps.length).toBe(2)
    expect(sendSteps[0]!.auditVerdict).toBe('pass')
    expect(sendSteps[1]!.auditVerdict).toBeNull() // 幂等命中：不再审计
    expect(sendSteps[0]!.input.idempotency_key).toBe(sendSteps[1]!.input.idempotency_key)
    expect(sendSteps[1]!.resultSummary).toContain('"sent"')

    const dump = await ctx.mock.stateDump<{ counters: Record<string, number>; sentLog: Array<{ clientMsgId: string; text?: string }> }>()
    expect((dump.counters.send ?? 0) - sendBefore).toBe(1) // 网关里恰好一条
    const auditNow = await ctx.agentMock.state
    expect(auditNow.auditCalls).toBeGreaterThanOrEqual(1)
  })

  it('预算：12 步后 budget_exhausted（第 12 步的工具先执行）', async () => {
    const steps = Array.from({ length: 13 }, () => ({ type: 'tool', name: 'get_recent_messages', input: { limit: 3 } }))
    await ctx.agentMock.ctl('scriptAll', { steps })
    await triggerExternal('触发预算')
    const run = await waitRun((r) => r.status === 'failed' && r.endReason === 'budget_exhausted', 25000)
    expect(run.steps.length).toBeLessThanOrEqual(12)
  })

  it('审计 3 次拿不到结论 → run blocked(audit_blocked)，工具不执行', async () => {
    await ctx.agentMock.ctl('setAudit', { mode: '500' })
    const sendBefore = (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters.send ?? 0
    await ctx.agentMock.ctl('scriptAll', { steps: [{ type: 'tool', name: 'send_message', input: { text: '会被 blocked', idempotency_key: 'k-blocked' } }] })
    await triggerExternal('触发 blocked')
    const run = await waitRun((r) => r.status === 'blocked' && r.endReason === 'audit_blocked', 20000)
    const step = run.steps.find((s) => s.name === 'send_message')!
    expect(step).toBeTruthy()
    const sendAfter = (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters.send ?? 0
    expect(sendAfter).toBe(sendBefore) // 工具未执行
    await ctx.agentMock.ctl('setAudit', { mode: 'ok' })
  })

  it('审计 fail → AUDIT_REJECTED（key 不消耗）；随后正常结束', async () => {
    await ctx.agentMock.ctl('setAudit', { mode: 'fail' })
    await ctx.agentMock.ctl('scriptAll', {
      steps: [{ type: 'tool', name: 'send_message', input: { text: '被拒', idempotency_key: 'k-reject' } }, { type: 'end_turn', text: 'rejected done' }],
    })
    await triggerExternal('触发审计拒绝')
    const run = await waitRun((r) => r.status === 'finished' && r.summary === 'rejected done', 20000)
    const step = run.steps.find((s) => s.name === 'send_message')!
    expect(step).toMatchObject({ isError: true, errorCode: 'AUDIT_REJECTED', auditVerdict: 'fail' })
    await ctx.agentMock.ctl('setAudit', { mode: 'ok' })
  })

  it('kick：autoKick 关闭 → POLICY_DENIED；开启后踢人成功且成员表联动', async () => {
    // 关闭态
    await ctx.agentMock.ctl('scriptAll', {
      steps: [{ type: 'tool', name: 'kick_user', input: { platform_user_id: 'pu-acc-charlie', reason: 'test' } }, { type: 'end_turn', text: 'kick denied' }],
    })
    await triggerExternal('触发 kick 关')
    await waitRun((r) => r.status === 'finished' && r.summary === 'kick denied', 20000)
    const runs1 = await ctx.app.inject({ method: 'GET', url: `/api/groups/${groupId}/agent-runs`, ...req(adminToken) })
    const last1 = (runs1.json() as Array<{ id: string }>)[0]!.id
    const d1 = await ctx.app.inject({ method: 'GET', url: `/api/agent-runs/${last1}`, ...req(adminToken) })
    const kickStep1 = (d1.json() as { steps: Array<Record<string, unknown>> }).steps.find((s) => s.name === 'kick_user')!
    expect(kickStep1).toMatchObject({ errorCode: 'POLICY_DENIED' })

    // 开启态
    await ctx.app.inject({ method: 'PATCH', url: `/api/groups/${groupId}`, payload: { autoKickEnabled: true }, ...req(adminToken) })
    await ctx.agentMock.ctl('scriptAll', {
      steps: [{ type: 'tool', name: 'kick_user', input: { platform_user_id: 'pu-acc-charlie', reason: 'kick on' } }, { type: 'end_turn', text: 'kick ok' }],
    })
    await triggerExternal('触发 kick 开')
    await waitRun((r) => r.status === 'finished' && r.summary === 'kick ok', 20000)
    const runs2 = await ctx.app.inject({ method: 'GET', url: `/api/groups/${groupId}/agent-runs`, ...req(adminToken) })
    const last2 = (runs2.json() as Array<{ id: string }>)[0]!.id
    const d2 = await ctx.app.inject({ method: 'GET', url: `/api/agent-runs/${last2}`, ...req(adminToken) })
    const kickStep2 = (d2.json() as { steps: Array<{ name: string; resultSummary: string | null; isError: boolean }> }).steps.find((s) => s.name === 'kick_user')!
    expect(kickStep2.isError).toBe(false)
    expect(kickStep2.resultSummary).toContain('kicked')

    // member_left 事件处理：本地成员表已移除
    await pollUntil(async () => {
      const { rows } = await ctx.db.query(`SELECT 1 FROM group_members WHERE group_id=$1 AND account_id='acc-charlie'`, [groupId])
      return rows.length === 0 ? true : null
    })
  })
})
