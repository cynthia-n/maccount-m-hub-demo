import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode } from '@mhub/shared'
import { login, pollUntil, setupRuntimeTest, teardownRuntimeTest, type RuntimeCtx } from '../helpers'

let ctx: RuntimeCtx
let adminToken = ''
let groupId = ''
let gwGroupId = ''

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
  const group = (g.json() as Array<{ id: string; gatewayGroupId: string }>)[0]!
  groupId = group.id
  gwGroupId = group.gatewayGroupId
}, 30_000)

afterAll(async () => {
  await teardownRuntimeTest(ctx)
})

async function send(accountId: string, text: string): Promise<{ status: number; clientMsgId?: string; code?: string }> {
  const r = await ctx.app.inject({
    method: 'POST',
    url: `/api/groups/${groupId}/send`,
    payload: { accountId, text },
    ...req(adminToken),
  })
  const body = r.json() as { clientMsgId?: string; error?: { code?: string } }
  return { status: r.statusCode, clientMsgId: body.clientMsgId, code: body.error?.code }
}

async function counters(): Promise<Record<string, number>> {
  return (await ctx.mock.stateDump<{ counters: Record<string, number> }>()).counters
}

async function timeline(): Promise<Array<{ msgId: string | null; clientMsgId: string | null; deliveryStatus: string | null; failCode: string | null; isOwn: boolean; text: string }>> {
  const r = await ctx.app.inject({ method: 'GET', url: `/api/groups/${groupId}/messages?limit=100`, ...req(adminToken) })
  return (r.json() as { items: Array<Record<string, never>> }).items as never
}

async function waitDelivery(clientMsgId: string, status: string, timeoutMs = 6000): Promise<void> {
  await pollUntil(async () => {
    const items = await timeline()
    const m = items.find((i) => i.clientMsgId === clientMsgId)
    return m && m.deliveryStatus === status ? true : null
  }, { timeoutMs, intervalMs: 80 })
}

describe('A2/S1 出站生命周期', () => {
  it('send 202 → accepted → sent；一条消息一行且 isOwn', async () => {
    const r = await send('acc-charlie', 'hello world')
    expect(r.status).toBe(202)
    expect(r.clientMsgId).toBeTruthy()

    await waitDelivery(r.clientMsgId!, 'accepted')
    await waitDelivery(r.clientMsgId!, 'sent')

    const items = await timeline()
    const mine = items.filter((i) => i.clientMsgId === r.clientMsgId)
    expect(mine.length).toBe(1) // 回流合并：一条消息一行
    expect(mine[0]!.isOwn).toBe(true)
    expect(mine[0]!.msgId).toMatch(/^msg-/)
  })

  it('入群校验：不在群 → ACCOUNT_NOT_IN_GROUP；离线账号 → ACCOUNT_UNAVAILABLE', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/accounts/acc-delta/connect', ...req(adminToken) })
    const notMember = await send('acc-delta', 'x')
    expect(notMember.status).toBe(409)
    expect(notMember.code).toBe(ErrorCode.ACCOUNT_NOT_IN_GROUP)

    await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts/acc-charlie/transition',
      payload: { to: 'disconnected', expectedFrom: 'online' },
      ...req(adminToken),
    })
    const unavailable = await send('acc-charlie', 'x')
    expect(unavailable.status).toBe(409)
    expect(unavailable.code).toBe(ErrorCode.ACCOUNT_UNAVAILABLE)
    // 恢复在线：transition 到 online 不调网关 connect，重连必须走 connect 接口
    const back = await ctx.app.inject({ method: 'POST', url: '/api/accounts/acc-charlie/connect', ...req(adminToken) })
    expect(back.statusCode).toBe(200)
  })

  it('S4 限流：等待期不向网关发送、保持 queued，到期按序发出', async () => {
    await ctx.mock.ctl('setRateLimit', { accountId: 'acc-charlie', retryAfterSeconds: 1 })
    const baseline = (await counters()).send ?? 0
    const r1 = await send('acc-charlie', 'limited-1')
    const r2 = await send('acc-charlie', 'limited-2')
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)

    // 等第一次尝试（收到 429）发生后再采样，窗口内不允许任何新尝试
    await pollUntil(async () => (((await counters()).send ?? 0) >= baseline + 1 ? true : null))
    const before = (await counters()).send ?? 0
    await new Promise((res) => setTimeout(res, 500))
    const after = (await counters()).send ?? 0
    expect(after).toBe(before) // 等待期网关收不到该账号的 send

    // 到期自动恢复并按序发出
    await waitDelivery(r1.clientMsgId!, 'sent', 8000)
    await waitDelivery(r2.clientMsgId!, 'sent', 8000)

    const { rows } = await ctx.db.query(`SELECT status FROM accounts WHERE id='acc-charlie'`)
    expect(rows[0]!.status).toBe('online')
  })

  it('504 且消息实际已落地：unknown → 探测定案 sent（不重发）', async () => {
    await ctx.mock.ctl('setSend504', { count: 1 })
    await ctx.mock.ctl('setSentLatencyMs', { min: 60, max: 120 })
    const before = (await counters()).send ?? 0
    const r = await send('acc-bravo', '504-landed')
    expect(r.status).toBe(202)

    await waitDelivery(r.clientMsgId!, 'unknown')
    await waitDelivery(r.clientMsgId!, 'sent', 8000)
    const after = await ctx.mock.stateDump<{ counters: Record<string, number>; sentLog: Array<{ clientMsgId: string }> }>()
    expect((after.counters.send ?? 0) - before).toBe(1) // 未重发
    expect(after.sentLog.filter((s) => s.clientMsgId === r.clientMsgId).length).toBe(1)
    await ctx.mock.ctl('setSentLatencyMs', { min: 60, max: 200 })
  })

  it('504 且消息丢失：确认后用同一 clientMsgId 重发一次；再丢 → failed(NETWORK_TIMEOUT)', async () => {
    await ctx.mock.ctl('setSend504Lost', { count: 2 })
    const before = (await counters()).send ?? 0
    const r = await send('acc-bravo', '504-lost-both')
    await waitDelivery(r.clientMsgId!, 'failed', 10000)
    const after = await ctx.mock.stateDump<{ counters: Record<string, number>; sentLog: Array<{ clientMsgId: string }> }>()
    expect((after.counters.send ?? 0) - before).toBe(2) // 恰好重发一次，总共两次
    expect(after.sentLog.filter((s) => s.clientMsgId === r.clientMsgId).length).toBe(0)
    const items = await timeline()
    const m = items.find((i) => i.clientMsgId === r.clientMsgId)!
    expect(m.deliveryStatus).toBe('failed')
    expect(m.failCode).toBe('NETWORK_TIMEOUT')
  })

  it('504 丢失后重发成功：网关里恰好一条', async () => {
    await ctx.mock.ctl('setSend504Lost', { count: 1 })
    const r = await send('acc-bravo', '504-lost-once')
    await waitDelivery(r.clientMsgId!, 'sent', 10000)
    const after = await ctx.mock.stateDump<{ sentLog: Array<{ clientMsgId: string }> }>()
    expect(after.sentLog.filter((s) => s.clientMsgId === r.clientMsgId).length).toBe(1)
  })

  it('by-client-id 503 期间保持 unknown，恢复后定案', async () => {
    await ctx.mock.ctl('setSend504Lost', { count: 1 })
    await ctx.mock.ctl('setByClientId503', { ms: 700 })
    const r = await send('acc-bravo', 'probe-503')
    await waitDelivery(r.clientMsgId!, 'unknown')
    // 503 期间不误判为 failed
    await new Promise((res) => setTimeout(res, 500))
    const items = await timeline()
    const m = items.find((i) => i.clientMsgId === r.clientMsgId)!
    expect(m.deliveryStatus === 'unknown' || m.deliveryStatus === 'sent').toBe(true)
    await waitDelivery(r.clientMsgId!, 'sent', 10000)
  })

  it('GROUP_WRITE_FORBIDDEN：群 unreachable + 该群 queued failed(GROUP_UNREACHABLE)', async () => {
    // 先排一条 queued（用限流挡住发送）
    await ctx.mock.ctl('setRateLimit', { accountId: 'acc-charlie', retryAfterSeconds: 3 })
    const queued = await send('acc-charlie', 'will-be-unreachable')
    expect(queued.status).toBe(202)

    await ctx.mock.ctl('setGroupWriteForbidden', { groupId: gwGroupId })
    const r = await send('acc-bravo', 'write-forbidden')
    // bravo 的 send 直接被网关拒
    await pollUntil(async () => {
      const { rows } = await ctx.db.query<{ status: string }>(`SELECT status FROM groups WHERE id=$1`, [groupId])
      return rows[0]!.status === 'unreachable' ? true : null
    })
    const items = await timeline()
    const failedMsg = items.find((i) => i.clientMsgId === r.clientMsgId)
    expect(failedMsg?.failCode).toBe('GROUP_WRITE_FORBIDDEN')
    const queuedMsg = items.find((i) => i.clientMsgId === queued.clientMsgId)
    expect(queuedMsg?.deliveryStatus === 'failed' || queuedMsg?.deliveryStatus === 'cancelled').toBe(true)
    expect(queuedMsg?.failCode).toBe('GROUP_UNREACHABLE')
  })
})

describe('A4 时间线 keyset 分页', () => {
  it('游标翻页不重不漏；翻页中途的新消息不影响已读窗口', async () => {
    const g2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo'] },
      ...req(adminToken),
    })
    const { jobId } = g2.json() as { jobId: string }
    await pollUntil(async () => {
      const j = await ctx.app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, ...req(adminToken) })
      return j.json().status === 'finished' ? true : null
    }, { timeoutMs: 8000 })
    const groups = await ctx.app.inject({ method: 'GET', url: '/api/groups', ...req(adminToken) })
    const g2id = (groups.json() as Array<{ id: string }>)[0]!.id

    // 灌 55 条
    for (let i = 0; i < 55; i++) {
      await ctx.db.query(
        `INSERT INTO messages (group_id, msg_id, direction, sender_platform_user_id, is_own, text, sent_at)
         VALUES ($1, $2, 'inbound', 'pu-ext', false, $3, now() - make_interval(secs => $4))`,
        [g2id, `pg-${i}`, `msg ${i}`, 100 - i],
      )
    }

    const collected: Array<{ msgId: string | null }> = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const url = `/api/groups/${g2id}/messages?limit=10${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`
      const r = await ctx.app.inject({ method: 'GET', url, ...req(adminToken) })
      const body = r.json() as { items: Array<{ msgId: string | null }>; nextCursor: string | null }
      collected.push(...body.items)
      if (!body.nextCursor) break
      cursor = body.nextCursor
      if (page === 1) {
        // 翻页中途写入新消息（更新的 sent_at）——不应影响后续页
        await ctx.db.query(
          `INSERT INTO messages (group_id, msg_id, direction, sender_platform_user_id, is_own, text, sent_at)
           VALUES ($1, 'pg-new', 'inbound', 'pu-ext', false, 'new during paging', now())`,
          [g2id],
        )
      }
    }
    const ids = collected.map((c) => c.msgId)
    expect(new Set(ids).size).toBe(ids.length) // 无重复
    expect(ids.length).toBeGreaterThanOrEqual(55)
    // 严格按 sent_at 倒序
    const r = await ctx.app.inject({ method: 'GET', url: `/api/groups/${g2id}/messages?limit=200`, ...req(adminToken) })
    const all = (r.json() as { items: Array<{ msgId: string | null; sentAt: string }> }).items
    const times = all.map((i) => i.sentAt)
    expect([...times].sort().reverse()).toEqual(times)
  })
})
