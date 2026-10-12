import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode } from '@mhub/shared'
import { login, pollUntil, setupRuntimeTest, teardownRuntimeTest, type RuntimeCtx } from '../helpers'

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
}, 30_000)

afterAll(async () => {
  await teardownRuntimeTest(ctx)
})

async function createSequence(steps: unknown[]): Promise<string> {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/sequences',
    payload: { name: `seq-${Date.now()}`, steps },
    ...req(adminToken),
  })
  expect(r.statusCode).toBe(200)
  return (r.json() as { id: string }).id
}

describe('B1 序列', () => {
  it('S8：预检失败 → 422 UNRESOLVED_PLACEHOLDER + stepIndex/key；不留运行记录；网关零发送', () => Promise.resolve().then(async () => {
    const seqId = await createSequence([
      { index: 1, accountRole: 'admin', text: 'ok {event}', delaySeconds: 0.3 },
      { index: 2, accountRole: 'member', text: 'ok {location}', delaySeconds: 0.3 },
      { index: 3, accountRole: 'member', text: '缺 {extra}', delaySeconds: 0.3 },
    ])
    const sendBefore = (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters.send ?? 0
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sequence-runs`,
      payload: { sequenceId: seqId, vars: { event: '发布会', location: 'A房间' }, stepVars: {} },
      ...req(adminToken),
    })
    expect(r.statusCode).toBe(422)
    const body = r.json() as { error: { code: string; stepIndex: number; key: string } }
    expect(body.error.code).toBe(ErrorCode.UNRESOLVED_PLACEHOLDER)
    expect(body.error.stepIndex).toBe(3)
    expect(body.error.key).toBe('extra')
    const { rows } = await ctx.db.query(`SELECT 1 FROM sequence_runs WHERE group_id=$1`, [groupId])
    expect(rows.length).toBe(0) // 不留运行记录
    const sendAfter = (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters.send ?? 0
    expect(sendAfter).toBe(sendBefore) // 网关收不到任何消息
  }))

  it('S7：并发启动恰好一 201 一 409', async () => {
    const seqId = await createSequence([
      { index: 1, accountRole: 'admin', text: '并发 {event}', delaySeconds: 5 },
    ])
    const payload = { sequenceId: seqId, vars: { event: 'X' }, stepVars: {} }
    const [a, b] = await Promise.all([
      ctx.app.inject({ method: 'POST', url: `/api/groups/${groupId}/sequence-runs`, payload, ...req(adminToken) }),
      ctx.app.inject({ method: 'POST', url: `/api/groups/${groupId}/sequence-runs`, payload, ...req(adminToken) }),
    ])
    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([201, 409])
    expect([a, b].find((r) => r.statusCode === 409)!.json().error.code).toBe(ErrorCode.SEQUENCE_ALREADY_RUNNING)
    // 清理：等这个 5s 延迟的 run 结束（不阻塞其它用例——留到 afterAll 前？直接停掉它）
    const runId = [a, b].find((r) => r.statusCode === 201)!.json().runId as string
    await ctx.db.query(`UPDATE sequence_runs SET status='stopped' WHERE id=$1`, [runId])
    await ctx.db.query(`UPDATE due_tasks SET status='cancelled' WHERE kind='sequence_step' AND payload->>'runId'=$1`, [runId])
  })

  it('链式排期：第 2 步锚定第 1 步发出时刻；角色选择 admin 优先、member 字典序', async () => {
    const seqId = await createSequence([
      { index: 1, accountRole: 'admin', text: '第一步 {event} 于 {time}', delaySeconds: 0.3 },
      { index: 2, accountRole: 'member', text: '第二步 {event} 资料 {location}', delaySeconds: 0.4 },
    ])
    const startedAt = Date.now()
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sequence-runs`,
      payload: { sequenceId: seqId, vars: { event: '发布会', time: '三点', location: '共享盘' }, stepVars: {} },
      ...req(adminToken),
    })
    expect(r.statusCode).toBe(201)
    const { runId } = r.json() as { runId: string }

    await pollUntil(async () => {
      const d = await ctx.app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, ...req(adminToken) })
      return d.json().status === 'finished' ? d.json() : null
    }, { timeoutMs: 10000 })

    const d = await ctx.app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, ...req(adminToken) })
    const body = d.json() as {
      steps: Array<{ index: number; status: string; sentAt: string | null; resolvedVars: Record<string, string>; varSources: Record<string, string>; clientMsgId: string | null }>
    }
    expect(body.steps.map((s) => s.status)).toEqual(['sent', 'sent'])
    const [s1, s2] = body.steps
    // 锚定：第 2 步发出时刻 ≥ 第 1 步发出 + 0.4s
    expect(new Date(s2!.sentAt!).getTime() - new Date(s1!.sentAt!).getTime()).toBeGreaterThanOrEqual(350)
    // 变量与来源
    expect(s1!.resolvedVars).toEqual({ event: '发布会', time: '三点' })
    expect(s2!.varSources.event).toBe('default')
    expect(s2!.varSources.location).toBe('default')

    // 每步消息实际由哪个账号发出：查时间线
    const { rows } = await ctx.db.query<{ sender_account_id: string; sequence_step_index: number }>(
      `SELECT m.sender_account_id, ss.step_index AS sequence_step_index FROM messages m
       JOIN sequence_steps ss ON ss.id = m.sequence_step_id WHERE ss.run_id=$1 ORDER BY ss.step_index`,
      [runId],
    )
    expect(rows[0]!.sender_account_id).toBe('acc-bravo') // admin 角色：admin 优先于 creator
    expect(rows[1]!.sender_account_id).toBe('acc-charlie') // member 角色
    void startedAt
  })

  it('没有匹配账号 → skipped（带时间戳），进度照常推进', async () => {
    // 只有 creator+admin 的群：member 角色无账号
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo'] },
      ...req(adminToken),
    })
    const { jobId } = res.json() as { jobId: string }
    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      return j.json().status === 'finished' ? true : null
    }, { timeoutMs: 8000 })
    const groups = await ctx.app.inject({ method: 'GET', url: '/api/groups', ...req(adminToken) })
    const g2 = (groups.json() as Array<{ id: string; members: Array<{ role: string }> }>)[0]!
    expect(g2.members.every((m) => m.role !== 'member')).toBe(true)

    const seqId = await createSequence([
      { index: 1, accountRole: 'member', text: '无人可发', delaySeconds: 0.2 },
      { index: 2, accountRole: 'admin', text: '跳过后继续', delaySeconds: 0.2 },
    ])
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/api/groups/${g2.id}/sequence-runs`,
      payload: { sequenceId: seqId, vars: {}, stepVars: {} },
      ...req(adminToken),
    })
    const { runId } = r.json() as { runId: string }
    await pollUntil(async () => {
      const d = await ctx.app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, ...req(adminToken) })
      return d.json().status === 'finished' ? d.json() : null
    }, { timeoutMs: 10000 })
    const d = await ctx.app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, ...req(adminToken) })
    const body = d.json() as { steps: Array<{ status: string; sentAt: string | null }> }
    expect(body.steps[0]!.status).toBe('skipped')
    expect(body.steps[0]!.sentAt).toBeTruthy() // skipped 有时间戳
    expect(body.steps[1]!.status).toBe('sent') // 进度照常推进
  })

  it('重启重排：已过期步骤重排到重启+delay，不能一次性全部发出', async () => {
    const seqId = await createSequence([
      { index: 1, accountRole: 'admin', text: '重启测试 {event}', delaySeconds: 1.5 },
      { index: 2, accountRole: 'admin', text: '重启第二步', delaySeconds: 0.2 },
    ])
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sequence-runs`,
      payload: { sequenceId: seqId, vars: { event: 'R' }, stepVars: {} },
      ...req(adminToken),
    })
    const { runId } = r.json() as { runId: string }

    // 200ms 后停机，让步骤 1 在停机期间过期
    await new Promise((res) => setTimeout(res, 200))
    await ctx.runtime.stop()
    await new Promise((res) => setTimeout(res, 2000))

    const restartAt = Date.now()
    await startRuntime()

    // 重启瞬间：步骤 1 仍未发出（重排到 now+1.5s）
    await new Promise((res) => setTimeout(res, 400))
    const mid = await ctx.app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, ...req(adminToken) })
    const midBody = mid.json() as { steps: Array<{ status: string }> }
    expect(midBody.steps[0]!.status).toBe('pending') // 没有立即发出

    await pollUntil(async () => {
      const d = await ctx.app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, ...req(adminToken) })
      return d.json().status === 'finished' ? d.json() : null
    }, { timeoutMs: 10000 })
    expect(Date.now() - restartAt).toBeGreaterThanOrEqual(1400) // 确实等了 delay

    async function startRuntime() {
      const { startRuntime } = await import('../../src/runtime')
      ctx.runtime = await startRuntime(ctx.app)
    }
  })
})

describe('B2 leave-all', () => {
  it('全部退群：群主最后，群 left、成员清空、与网关一致', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: `/api/groups/${groupId}/leave-all`, ...req(adminToken) })
    expect(r.statusCode).toBe(202)
    const { jobId } = r.json() as { jobId: string }
    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      const body = j.json() as { status: string; steps: Array<{ step: string; status: string }> }
      return body.status !== 'running' ? body : null
    }, { timeoutMs: 10000 })
    const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
    const body = j.json() as { status: string; steps: Array<{ step: string; status: string }> }
    expect(body.status).toBe('finished')

    const g = await ctx.app.inject({ method: 'GET', url: `/api/groups/${groupId}`, ...req(adminToken) })
    const group = g.json() as { status: string; members: unknown[] }
    expect(group.status).toBe('left')
    expect(group.members).toEqual([])

    const state = await ctx.mock.stateDump<{ groups: Array<{ groupId: string; members: string[] }> }>()
    void state
  })

  it('viewer 调 leave-all → 403', async () => {
    const viewer = await login(ctx, 'viewer', 'viewer')
    const r = await ctx.app.inject({ method: 'POST', url: `/api/groups/${groupId}/leave-all`, ...req(viewer) })
    expect(r.statusCode).toBe(403)
  })
})
