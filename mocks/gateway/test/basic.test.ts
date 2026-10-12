import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildGatewayMock } from '../src/app'
import { parseSseBuffer } from '../../../server/src/gateway/sse-client'

let app: ReturnType<typeof buildGatewayMock>['app']
let state: ReturnType<typeof buildGatewayMock>['state']
let base = ''

beforeAll(async () => {
  const m = buildGatewayMock({ seedAccounts: ['acc-t1', 'acc-t2'] })
  app = m.app
  state = m.state
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => {
  await app.close()
})

async function ctl(op: string, params: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/__ctl', payload: { op, ...params } })
  return res.json()
}

/** 读完一段 SSE（读到 no-more-data 或超时），返回解析出的帧 */
async function readSse(since: number, waitMs = 400): Promise<{ id: number; event: string; data: any }[]> {
  const res = await fetch(`${base}/events?since=${since}`)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + waitMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timer = new Promise<null>((r) => setTimeout(r, Math.min(remaining, 60)))
    const chunk = await Promise.race([reader.read(), timer])
    if (!chunk) continue
    if (chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
  }
  try {
    await reader.cancel()
  } catch {}
  return parseSseBuffer(buf).frames.map((f) => ({ id: f.eventId, event: f.type, data: f.data }))
}

describe('gateway mock 基础行为', () => {
  it('connect 返回固定 platformUserId；重复 connect 一致', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/accounts/acc-t1/connect' })
    const r2 = await app.inject({ method: 'POST', url: '/accounts/acc-t1/connect' })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toEqual(r2.json())
    expect(r1.json().platformUserId).toBe('pu-acc-t1')
  })

  it('离线账号 send → 409 ACCOUNT_OFFLINE', async () => {
    const g = await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId: 'acc-t1' } })
    const groupId = g.json().groupId as string
    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/send`,
      payload: { accountId: 'acc-t2', clientMsgId: 'c1', text: 'x' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('ACCOUNT_OFFLINE')
  })

  it('send 202 → message_sent/message 事件；by-client-id 404→200', async () => {
    const groupId = (await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId: 'acc-t1' } })).json()
      .groupId as string
    await ctl('setSendLatencyMs', { min: 1, max: 5 })
    await ctl('setSentLatencyMs', { min: 1, max: 5 })
    const send = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/send`,
      payload: { accountId: 'acc-t1', clientMsgId: 'c-abc', text: 'hello' },
    })
    expect(send.statusCode).toBe(202)

    const before = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/c-abc` })
    expect([200, 404]).toContain(before.statusCode) // 可能已落地也可能尚未

    await new Promise((r) => setTimeout(r, 120))
    const after = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/c-abc` })
    expect(after.statusCode).toBe(200)
    expect(after.json().msgId).toMatch(/^msg-/)
  })

  it('重复推送开关：每个事件 N 份独立 eventId；SSE since 独占补拉', async () => {
    await ctl('setDuplicateEvents', { n: 2 })
    await ctl('setReorderWindowMs', { ms: 0 })
    const before = (await app.inject({ method: 'GET', url: '/__state' })).json().maxEventId as number
    await ctl('emit', { type: 'member_joined', data: { groupId: 'g-1', platformUserId: 'pu-acc-t2' } })
    const after = (await app.inject({ method: 'GET', url: '/__state' })).json().maxEventId as number
    expect(after - before).toBe(2)

    const frames = await readSse(before)
    const joined = frames.filter((f) => f.event === 'member_joined')
    expect(joined.length).toBe(2)
    expect(new Set(joined.map((f) => f.id)).size).toBe(2)
    await ctl('setDuplicateEvents', { n: 1 })
  })

  it('by-client-id 503 开关', async () => {
    await ctl('setByClientId503', { ms: 200 })
    const res = await app.inject({ method: 'GET', url: '/groups/g-1/messages/by-client-id/whatever' })
    expect(res.statusCode).toBe(503)
    await new Promise((r) => setTimeout(r, 250))
    const res2 = await app.inject({ method: 'GET', url: '/groups/g-1/messages/by-client-id/whatever' })
    expect(res2.statusCode).toBe(404)
  })

  it('invite 过期模式：链接 300ms 后使用 → 410', async () => {
    await ctl('setInvite', { mode: 'expire' })
    const g = (await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId: 'acc-t1' } })).json()
      .groupId as string
    const inv = (
      await app.inject({ method: 'POST', url: `/groups/${g}/invite` })
    ).json() as { inviteLink: string }
    await new Promise((r) => setTimeout(r, 350))
    const j = await app.inject({ method: 'POST', url: `/groups/${g}/join`, payload: { accountId: 'acc-t1', inviteLink: inv.inviteLink } })
    expect(j.statusCode).toBe(410)
    // 过期后重新申请即可再用
    const inv2 = (await app.inject({ method: 'POST', url: `/groups/${g}/invite` })).json() as { inviteLink: string }
    const j2 = await app.inject({ method: 'POST', url: `/groups/${g}/join`, payload: { accountId: 'acc-t1', inviteLink: inv2.inviteLink } })
    expect(j2.statusCode).toBe(409) // ALREADY_MEMBER：创建者本就是成员（过期校验已在前面拦住 410）
    await ctl('setInvite', { mode: 'normal' })
  })
})
