import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode } from '@mhub/shared'
import WebSocket from 'ws'
import { login, listenUrl, pollUntil, setupRuntimeTest, teardownRuntimeTest, type RuntimeCtx } from '../helpers'

let ctx: RuntimeCtx
let adminToken: string
let viewerToken: string
let baseUrl: string

beforeAll(async () => {
  ctx = await setupRuntimeTest()
  adminToken = await login(ctx, 'admin', 'admin')
  viewerToken = await login(ctx, 'viewer', 'viewer')
  baseUrl = await listenUrl(ctx.app)
}, 20_000)

afterAll(async () => {
  await teardownRuntimeTest(ctx)
}, 30_000)

const authedReq = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
})

describe('A1 账号列表与 connect', () => {
  it('GET /api/accounts 返回预置账号（viewer 可读）', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/accounts', ...authedReq(viewerToken) })
    expect(res.statusCode).toBe(200)
    const list = res.json() as Array<{ id: string; status: string; platformUserId: string | null; rateLimitedUntil: string | null }>
    expect(list.map((a) => a.id).sort()).toEqual(['acc-alpha', 'acc-bravo', 'acc-charlie', 'acc-delta'])
    expect(list.every((a) => a.status === 'idle' && a.platformUserId === null && a.rateLimitedUntil === null)).toBe(true)
  })

  it('connect：idle → online，platformUserId 落库；重复 connect 返回同一 pu', async () => {
    const r1 = await ctx.app.inject({ method: 'POST', url: '/api/accounts/acc-alpha/connect', ...authedReq(adminToken) })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toEqual({ status: 'online', platformUserId: 'pu-acc-alpha' })

    const r2 = await ctx.app.inject({ method: 'POST', url: '/api/accounts/acc-alpha/connect', ...authedReq(adminToken) })
    expect(r2.json()).toEqual({ status: 'online', platformUserId: 'pu-acc-alpha' })

    const list = await ctx.app.inject({ method: 'GET', url: '/api/accounts', ...authedReq(adminToken) })
    const alpha = (list.json() as Array<{ id: string; status: string }>).find((a) => a.id === 'acc-alpha')
    expect(alpha!.status).toBe('online')
  })

  it('viewer 调写接口 → 403 FORBIDDEN（直接调接口也被拦）', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/accounts/acc-bravo/connect', ...authedReq(viewerToken) })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe(ErrorCode.FORBIDDEN)

    const res2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-bravo/transition',
      payload: { to: 'online', expectedFrom: 'idle' },
      ...authedReq(viewerToken),
    })
    expect(res2.statusCode).toBe(403)
  })

  it('不存在的账号 → 404 ACCOUNT_NOT_FOUND', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/accounts/nope/connect', ...authedReq(adminToken) })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe(ErrorCode.ACCOUNT_NOT_FOUND)
  })
})

describe('A1 transition 与 CAS', () => {
  it('合法转移：online → disconnected（并调网关 disconnect），再 disconnected → idle', async () => {
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-alpha/transition',
      payload: { to: 'disconnected', expectedFrom: 'online' },
      ...authedReq(adminToken),
    })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toEqual({ status: 'disconnected' })

    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-alpha/transition',
      payload: { to: 'idle', expectedFrom: 'disconnected' },
      ...authedReq(adminToken),
    })
    expect(r2.json()).toEqual({ status: 'idle' })
  })

  it('同状态到同状态 → ILLEGAL_TRANSITION；不在表上的转移 → ILLEGAL_TRANSITION', async () => {
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-bravo/transition',
      payload: { to: 'idle', expectedFrom: 'idle' },
      ...authedReq(adminToken),
    })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe(ErrorCode.ILLEGAL_TRANSITION)

    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-bravo/transition',
      payload: { to: 'disconnected', expectedFrom: 'idle' },
      ...authedReq(adminToken),
    })
    expect(r2.json().error.code).toBe(ErrorCode.ILLEGAL_TRANSITION)
  })

  it('expectedFrom 不匹配 → CAS_CONFLICT', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-bravo/transition',
      payload: { to: 'online', expectedFrom: 'online' }, // 实际是 idle
      ...authedReq(adminToken),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe(ErrorCode.CAS_CONFLICT)
  })

  it('并发同一账号转移：恰好一 200 一 CAS_CONFLICT，不能后写覆盖', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-charlie/transition',
      payload: { to: 'online', expectedFrom: 'idle' },
      ...authedReq(adminToken),
    })
    const [a, b] = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url: '/api/accounts/acc-charlie/transition',
        payload: { to: 'disconnected', expectedFrom: 'online' },
        ...authedReq(adminToken),
      }),
      ctx.app.inject({
        method: 'POST',
        url: '/api/accounts/acc-charlie/transition',
        payload: { to: 'rate_limited', expectedFrom: 'online' },
        ...authedReq(adminToken),
      }),
    ])
    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([200, 409])
    expect([a, b].find((r) => r.statusCode === 409)!.json().error.code).toBe(ErrorCode.CAS_CONFLICT)
    const { rows } = await ctx.db.query(`SELECT status FROM accounts WHERE id='acc-charlie'`)
    expect(['disconnected', 'rate_limited']).toContain(rows[0]!.status)
  })
})

describe('A1 终态（网关事件来源）：全套副作用原子生效', () => {
  it('suspendAccount → 状态/成员/排队消息/WS 事件一致；重复事件静默', async () => {
    // 布置：delta online、在一个群里、有一条排队消息
    await ctx.app.inject({ method: 'POST', url: '/api/accounts/acc-delta/connect', ...authedReq(adminToken) })
    const g = await ctx.db.query<{ id: string }>(
      `INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ('g-susp', 'acc-delta') RETURNING id`,
    )
    const groupId = g.rows[0]!.id
    await ctx.db.query(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1, 'acc-delta', 'pu-acc-delta', 'creator')`,
      [groupId],
    )
    await ctx.db.query(
      `INSERT INTO messages (group_id, direction, sender_account_id, sender_platform_user_id, is_own, text, sent_at, delivery_status, client_msg_id)
       VALUES ($1, 'outbound', 'acc-delta', 'pu-acc-delta', true, 'queued msg', now(), 'queued', 'cm-susp-1')`,
      [groupId],
    )

    // 网关推终态
    await ctx.mock.ctl('suspendAccount', { accountId: 'acc-delta' })

    await pollUntil(async () => {
      const { rows } = await ctx.db.query<{ status: string }>(`SELECT status FROM accounts WHERE id='acc-delta'`)
      return rows[0]?.status === 'suspended' ? true : null
    })

    // 全套副作用
    const { rows: members } = await ctx.db.query(`SELECT 1 FROM group_members WHERE account_id='acc-delta'`)
    expect(members.length).toBe(0)
    const { rows: msgs } = await ctx.db.query<{ delivery_status: string; fail_code: string }>(
      `SELECT delivery_status, fail_code FROM messages WHERE client_msg_id='cm-susp-1'`,
    )
    expect(msgs[0]).toMatchObject({ delivery_status: 'cancelled', fail_code: 'ACCOUNT_TERMINAL' })
    const { rows: terminalEvents } = await ctx.db.query(
      `SELECT payload FROM ws_outbox WHERE type='account_terminal' AND payload->>'accountId'='acc-delta'`,
    )
    expect(terminalEvents.length).toBe(1)

    // 重复进入同一终态：静默忽略，不再推事件
    const before = terminalEvents.length
    await ctx.mock.ctl('suspendAccount', { accountId: 'acc-delta' })
    await new Promise((r) => setTimeout(r, 300))
    const { rows: after } = await ctx.db.query(
      `SELECT payload FROM ws_outbox WHERE type='account_terminal' AND payload->>'accountId'='acc-delta'`,
    )
    expect(after.length).toBe(before)
    const { rows: statusRow } = await ctx.db.query(`SELECT status FROM accounts WHERE id='acc-delta'`)
    expect(statusRow[0]!.status).toBe('suspended')
  })

  it('终态后 connect → 409 ILLEGAL_TRANSITION（重连不能恢复终态）', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/accounts/acc-delta/connect', ...authedReq(adminToken) })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe(ErrorCode.ILLEGAL_TRANSITION)
  })
})

describe('A1 限流到期恢复（due_tasks）', () => {
  it('到期且仍是 rate_limited → 自动回 online；已不是则不动', async () => {
    const { runDueTasks } = await import('../../src/workers/due-tasks')
    const { scheduleTask } = await import('../../src/workers/due-tasks')

    // bravo：rate_limited + 到期任务
    await ctx.db.query(`UPDATE accounts SET status='rate_limited', rate_limited_until=now() - interval '100 milliseconds' WHERE id='acc-bravo'`)
    await ctx.db.withTx((q) => scheduleTask(q, 'rate_limit_expire', new Date(Date.now() - 10), { accountId: 'acc-bravo' }))
    // charlie：已被操作员标离线，到期任务到达时不应转移
    await ctx.db.query(`UPDATE accounts SET status='disconnected' WHERE id='acc-charlie'`)
    await ctx.db.withTx((q) => scheduleTask(q, 'rate_limit_expire', new Date(Date.now() - 10), { accountId: 'acc-charlie' }))

    const ran = await runDueTasks(ctx.db, (await import('../../src/workers/task-handlers')).dueTaskHandlers())
    expect(ran).toBeGreaterThanOrEqual(2)

    const { rows } = await ctx.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM accounts WHERE id IN ('acc-bravo','acc-charlie')`,
    )
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]))
    expect(byId['acc-bravo']).toBe('online')
    expect(byId['acc-charlie']).toBe('disconnected') // 不做转移
  })
})

describe('WS /ws（A4/B4 基础）', () => {
  function collect(ws: WebSocket): { frames: Array<Record<string, unknown>>; waitClose: Promise<void> } {
    const frames: Array<Record<string, unknown>> = []
    const waitClose = new Promise<void>((resolve) => {
      ws.on('message', (d) => frames.push(JSON.parse(d.toString())))
      ws.on('close', resolve)
    })
    return { frames, waitClose }
  }

  it('认证成功后收到实时状态事件；带 sinceSeq 重连补齐不重复', async () => {
    const ws1 = new WebSocket(baseUrl.replace('http', 'ws') + '/ws')
    const c1 = collect(ws1)
    await new Promise((r) => ws1.on('open', r))
    ws1.send(JSON.stringify({ type: 'auth', accessToken: adminToken }))
    await pollUntil(async () => (c1.frames.some((f) => f.type === 'auth' && f.success === true) ? true : null))

    // 触发一个状态事件
    await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-bravo/transition',
      payload: { to: 'disconnected', expectedFrom: 'online' },
      ...authedReq(adminToken),
    })
    await pollUntil(async () =>
      c1.frames.some((f) => f.type === 'account_status_changed' && (f.payload as { to?: string }).to === 'disconnected')
        ? true
        : null,
    )
    ws1.close()

    // 断线重连 + sinceSeq 补齐（B4）
    const lastSeq = Math.max(...c1.frames.filter((f) => typeof f.seq === 'number').map((f) => f.seq as number))
    const ws2 = new WebSocket(baseUrl.replace('http', 'ws') + '/ws')
    const c2 = collect(ws2)
    await new Promise((r) => ws2.on('open', r))
    ws2.send(JSON.stringify({ type: 'auth', accessToken: adminToken, sinceSeq: lastSeq }))
    await pollUntil(async () => (c2.frames.some((f) => f.type === 'auth' && f.success === true) ? true : null))
    // 补齐的帧 seq 必须 > lastSeq（不重复）
    await new Promise((r) => setTimeout(r, 400))
    for (const f of c2.frames) {
      if (typeof f.seq === 'number') expect((f.seq as number) > lastSeq).toBe(true)
    }
    ws2.close()
  })

  it('坏 token → auth success:false 并关闭', async () => {
    const ws = new WebSocket(baseUrl.replace('http', 'ws') + '/ws')
    const { frames, waitClose } = collect(ws)
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ type: 'auth', accessToken: 'bad-token' }))
    await pollUntil(async () => (frames.some((f) => f.type === 'auth' && f.success === false) ? true : null))
    await waitClose
  })
})
