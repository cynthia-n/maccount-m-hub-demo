import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode } from '@mhub/shared'
import { pollUntil, setupRuntimeTest, teardownRuntimeTest, type RuntimeCtx } from '../helpers'

let ctx: RuntimeCtx

beforeAll(async () => {
  ctx = await setupRuntimeTest()
}, 20_000)

afterAll(async () => {
  await teardownRuntimeTest(ctx)
})

const admin = { headers: { authorization: 'Bearer x' } }
let adminToken = ''
let viewerToken = ''

async function loginAll() {
  const { login } = await import('../helpers')
  adminToken = await login(ctx, 'admin', 'admin')
  viewerToken = await login(ctx, 'viewer', 'viewer')
}

const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

async function connectAll(ids: string[]) {
  for (const id of ids) {
    const r = await ctx.app.inject({ method: 'POST', url: `/api/accounts/${id}/connect`, ...req(adminToken) })
    expect(r.statusCode).toBe(200)
  }
}

describe('A3 建群', () => {
  beforeAll(async () => {
    await loginAll()
  })

  it('提交校验：成员含群主 400；空成员 400；账号不在线 422', async () => {
    await connectAll(['acc-alpha', 'acc-bravo'])

    const bad1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-alpha'] },
      ...req(adminToken),
    })
    expect(bad1.statusCode).toBe(400)
    expect(bad1.json().error.code).toBe(ErrorCode.VALIDATION_ERROR)

    const bad2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: [] },
      ...req(adminToken),
    })
    expect(bad2.statusCode).toBe(400)

    const bad3 = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-delta'] }, // delta 未 connect
      ...req(adminToken),
    })
    expect(bad3.statusCode).toBe(422)
    expect(bad3.json().error.code).toBe(ErrorCode.ACCOUNT_NOT_ONLINE)
  })

  it('完整建群：job finished，成员与角色正确，与网关成员列表一致，promote 恰好 1 次', async () => {
    await connectAll(['acc-charlie'])
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo', 'acc-charlie'] },
      ...req(adminToken),
    })
    expect(res.statusCode).toBe(202)
    const { jobId } = res.json() as { jobId: string }

    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      return j.json().status === 'finished' ? j.json() : null
    }, { timeoutMs: 8000 })

    const groups = await ctx.app.inject({ method: 'GET', url: '/api/groups', ...req(adminToken) })
    const group = (groups.json() as Array<Record<string, unknown>>)[0]! as {
      id: string
      gatewayGroupId: string
      status: string
      members: Array<{ accountId: string; role: string; platformUserId: string | null }>
      activeAgentRunId: string | null
      activeSequenceRunId: string | null
    }
    expect(group.gatewayGroupId).toMatch(/^g-/)
    expect(group.status).toBe('active')
    const roles = Object.fromEntries(group.members.map((m) => [m.accountId, m.role]))
    expect(roles).toEqual({ 'acc-alpha': 'creator', 'acc-bravo': 'admin', 'acc-charlie': 'member' })

    // 与网关成员列表一致
    const state = await ctx.mock.stateDump<{ groups: Array<{ groupId: string; members: string[] }>; counters: Record<string, number> }>()
    const gwGroup = state.groups.find((g) => g.groupId === group.gatewayGroupId)!
    expect(new Set(gwGroup.members)).toEqual(new Set(group.members.map((m) => m.platformUserId)))
    expect(state.counters.promote).toBe(1) // A2：promote 调用总数 ≤ 2，正常流程 1 次

    // 单群查询
    const one = await ctx.app.inject({ method: 'GET', url: `/api/groups/${group.id}`, ...req(adminToken) })
    expect(one.statusCode).toBe(200)
    expect((one.json() as { activeAgentRunId: string | null }).activeAgentRunId).toBeNull()
  })

  it('ALREADY_MEMBER：视为成功，直接 promote（不依赖 member_joined）', async () => {
    const { GatewayClient } = await import('../../src/gateway/client')
    const gw = new GatewayClient(ctx.mock.url)
    const gwGroupId = (await gw.createGroup('acc-alpha')).body.groupId
    const inv = (await gw.invite(gwGroupId)).body
    // bravo 其实已经在群里（join 将得到 ALREADY_MEMBER）
    ctx.mock.state.groups.get(gwGroupId)!.members.add('pu-acc-bravo')

    // 我们的 DB：布置 job 到 join 步（create/invite 已完成）
    const g = await ctx.db.query<{ id: string }>(
      `INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ($1, 'acc-alpha') RETURNING id`,
      [gwGroupId],
    )
    const groupId = g.rows[0]!.id
    const job = await ctx.db.query<{ id: string }>(
      `INSERT INTO jobs (type, group_id, params) VALUES ('create_group', $1, $2::jsonb) RETURNING id`,
      [groupId, JSON.stringify({ creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo', 'acc-charlie'] })],
    )
    const jobId = job.rows[0]!.id
    for (const [step, status, detail] of [
      ['create', 'done', { gatewayGroupId: gwGroupId }],
      ['invite', 'done', { inviteLink: inv.inviteLink, readyAfterMs: inv.readyAfterMs }],
      ['join:acc-bravo', 'pending', {}],
      ['join:acc-charlie', 'pending', {}],
      ['promote', 'pending', {}],
    ] as const) {
      await ctx.db.query('INSERT INTO job_steps (job_id, step, status, detail) VALUES ($1,$2,$3,$4::jsonb)', [
        jobId, step, status, JSON.stringify(detail),
      ])
    }

    const { advanceJob } = await import('../../src/domain/jobs')
    await advanceJob(ctx.db, jobId, gw)

    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      return j.json().status === 'finished' ? true : null
    }, { timeoutMs: 8000 })

    const { rows: steps } = await ctx.db.query<{ step: string; detail: Record<string, unknown> }>(
      'SELECT step, detail FROM job_steps WHERE job_id=$1',
      [jobId],
    )
    const bravo = steps.find((s) => s.step === 'join:acc-bravo')!
    expect(bravo.detail.alreadyMember).toBe(true)
    // bravo 直接进成员表；promote 完成后角色为 admin（memberAccountIds[0]）
    const { rows: bravoMember } = await ctx.db.query(
      `SELECT role FROM group_members WHERE group_id=$1 AND account_id='acc-bravo'`,
      [groupId],
    )
    expect(bravoMember[0]?.role).toBe('admin')
  })

  it('JOIN_TIMEOUT：member_joined 永不到 → job failed JOIN_TIMEOUT', async () => {
    await ctx.mock.ctl('setJoinSilent', { accountId: 'acc-charlie' })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo', 'acc-charlie'] },
      ...req(adminToken),
    })
    const { jobId } = res.json() as { jobId: string }
    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      return j.json().status === 'failed' ? j.json() : null
    }, { timeoutMs: 8000 })
    const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
    expect(j.json().errors).toEqual([{ step: 'join:acc-charlie', code: 'JOIN_TIMEOUT' }])
    await ctx.mock.ctl('setJoinSilent', { accountId: 'acc-charlie' }) // 重复设置无害，显式恢复语义
    // 清除 silent（mock 无 remove 接口——直接改状态）
    ctx.mock.state.silentJoin.delete('acc-charlie')
  })

  it('INVITE_NOT_READY：等到 readyAfterMs 后完成', async () => {
    await ctx.mock.ctl('setInvite', { mode: 'notReady', readyAfterMs: 400 })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-bravo', memberAccountIds: ['acc-charlie'] },
      ...req(adminToken),
    })
    const { jobId } = res.json() as { jobId: string }
    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      return j.json().status === 'finished' ? true : null
    }, { timeoutMs: 8000 })
    const state = await ctx.mock.stateDump<{ counters: Record<string, number> }>()
    expect(state.counters.invite).toBeGreaterThanOrEqual(1)
    await ctx.mock.ctl('setInvite', { mode: 'normal' })
  })

  it('INVITE_EXPIRED：重新申请链接后重试成功', async () => {
    await ctx.mock.ctl('setInvite', { mode: 'expire' })
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-bravo', memberAccountIds: ['acc-charlie'] },
      ...req(adminToken),
    })
    const { jobId } = res.json() as { jobId: string }
    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      return j.json().status === 'finished' ? true : null
    }, { timeoutMs: 10000 })
    await ctx.mock.ctl('setInvite', { mode: 'normal' })
  })

  it('viewer 建群 → 403', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo'] },
      ...req(viewerToken),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe(ErrorCode.FORBIDDEN)
  })
})
