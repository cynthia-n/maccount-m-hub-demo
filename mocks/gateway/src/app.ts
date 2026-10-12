import fastify, { type FastifyInstance } from 'fastify'
import {
  accountGuard,
  ctl,
  createState,
  detachMember,
  err,
  gatewayGuard,
  kickTarget,
  planSend,
  pushEvent,
  pushMemberLeft,
  removeMember,
  terminateAccount,
  type MockState,
} from './state'

export interface GatewayMockOptions {
  seedAccounts?: string[]
}

export interface GatewayMock {
  app: FastifyInstance
  state: MockState
}

export function buildGatewayMock(opts: GatewayMockOptions = {}): GatewayMock {
  const state = createState(opts.seedAccounts ?? ['acc-alpha', 'acc-bravo', 'acc-charlie', 'acc-delta'])
  const app = fastify({ logger: false })

  const respond = (reply: import('fastify').FastifyReply, r: { status: number; body: unknown }) =>
    reply.status(r.status).send(r.body)

  app.get('/api/health', async () => ({ ok: true, service: 'gateway-mock' }))

  // ── 账号 ────────────────────────────────────────────────
  app.post('/accounts/:accountId/connect', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const acc = state.accounts.get((req.params as { accountId: string }).accountId)
    if (!acc) return respond(reply, err(404, 'ACCOUNT_NOT_FOUND'))
    if (acc.terminal) {
      return respond(reply, acc.terminal === 'suspended' ? err(403, 'ACCOUNT_SUSPENDED') : err(401, 'SESSION_EXPIRED'))
    }
    acc.online = true
    return { platformUserId: acc.platformUserId }
  })

  app.post('/accounts/:accountId/disconnect', async (req, reply) => {
    const acc = state.accounts.get((req.params as { accountId: string }).accountId)
    if (!acc) return respond(reply, err(404, 'ACCOUNT_NOT_FOUND'))
    if (acc.terminal) {
      return respond(reply, acc.terminal === 'suspended' ? err(403, 'ACCOUNT_SUSPENDED') : err(401, 'SESSION_EXPIRED'))
    }
    acc.online = false
    return {}
  })

  // ── 群与成员 ─────────────────────────────────────────────
  app.post('/groups', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const { creatorAccountId } = req.body as { creatorAccountId: string }
    const guard = accountGuard(state, creatorAccountId)
    if (guard) return respond(reply, guard)
    const acc = state.accounts.get(creatorAccountId)!
    const groupId = `g-${state.nextGroupId++}`
    const group = { groupId, owner: acc.platformUserId, members: new Set([acc.platformUserId]), admins: new Set<string>(), writeForbidden: false }
    state.groups.set(groupId, group)
    return { groupId }
  })

  app.post('/groups/:groupId/invite', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const { groupId } = req.params as { groupId: string }
    if (!state.groups.has(groupId)) return respond(reply, err(404, 'GROUP_NOT_FOUND'))
    const mode = state.knobs.inviteMode
    const readyAfterMs = mode === 'notReady' ? state.knobs.notReadyMs : 0
    const expiresAt = mode === 'expire' ? Date.now() + 300 : null
    const inviteLink = `inv-${groupId}-${state.inviteSeq++}`
    state.invites.set(inviteLink, { groupId, readyAt: Date.now() + readyAfterMs, expiresAt })
    return { inviteLink, readyAfterMs }
  })

  app.post('/groups/:groupId/join', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const { groupId } = req.params as { groupId: string }
    const { accountId, inviteLink } = req.body as { accountId: string; inviteLink: string }
    const guard = accountGuard(state, accountId)
    if (guard) return respond(reply, guard)
    const invite = state.invites.get(inviteLink)
    if (!invite || invite.groupId !== groupId) return respond(reply, err(400, 'INVITE_INVALID'))
    if (Date.now() < invite.readyAt) return respond(reply, err(409, 'INVITE_NOT_READY'))
    if (invite.expiresAt && Date.now() > invite.expiresAt) return respond(reply, err(410, 'INVITE_EXPIRED'))
    const acc = state.accounts.get(accountId)!
    const group = state.groups.get(groupId)!
    if (group.members.has(acc.platformUserId)) return respond(reply, err(409, 'ALREADY_MEMBER'))

    if (state.silentJoin.has(accountId)) return reply.status(202).send({ accepted: true })
    const [min, max] = state.knobs.joinLatencyMs
    const delay = min + Math.floor(Math.random() * (max - min + 1))
    state.timers.add(
      setTimeout(() => {
        group.members.add(acc.platformUserId)
        pushEvent(state, 'member_joined', { groupId, platformUserId: acc.platformUserId })
      }, delay),
    )
    return reply.status(202).send({ accepted: true })
  })

  app.post('/groups/:groupId/promote', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const { groupId } = req.params as { groupId: string }
    const { byAccountId, accountId } = req.body as { byAccountId: string; accountId: string }
    const guard = accountGuard(state, byAccountId)
    if (guard) return respond(reply, guard)
    const group = state.groups.get(groupId)
    if (!group) return respond(reply, err(404, 'GROUP_NOT_FOUND'))
    const by = state.accounts.get(byAccountId)!
    if (group.owner !== by.platformUserId) return respond(reply, err(403, 'NO_PERMISSION'))
    const target = state.accounts.get(accountId)
    if (!target || !group.members.has(target.platformUserId)) return respond(reply, err(409, 'NOT_MEMBER_YET'))
    group.admins.add(target.platformUserId)
    return {}
  })

  app.post('/groups/:groupId/kick', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const { groupId } = req.params as { groupId: string }
    const { byAccountId, targetPlatformUserId } = req.body as { byAccountId: string; targetPlatformUserId: string }
    const guard = kickTarget(state, groupId, byAccountId, targetPlatformUserId)
    if (guard) return respond(reply, guard)

    const [min, max] = state.knobs.kickLatencyMs
    const delay = min + Math.floor(Math.random() * (max - min + 1))
    if (state.knobs.kick504Left > 0) {
      state.knobs.kick504Left -= 1
      // 结果未知：≤2s 内收敛（这里 1s 后移除并推事件）
      state.timers.add(
        setTimeout(() => {
          detachMember(state, groupId, targetPlatformUserId)
          pushMemberLeft(state, groupId, targetPlatformUserId)
        }, Math.min(delay + 800, 2000)),
      )
      return reply.status(504).send({ error: { code: 'NETWORK_TIMEOUT', message: 'upstream timeout' } })
    }
    // 题面：目标在 200 返回前已从成员列表移除，随后推 member_left
    detachMember(state, groupId, targetPlatformUserId)
    state.timers.add(setTimeout(() => pushMemberLeft(state, groupId, targetPlatformUserId), delay))
    return { kicked: true }
  })

  app.post('/groups/:groupId/leave', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const { groupId } = req.params as { groupId: string }
    const { accountId } = req.body as { accountId: string }
    const guard = accountGuard(state, accountId)
    if (guard) return respond(reply, guard)
    if (state.knobs.leave500Left > 0) {
      state.knobs.leave500Left -= 1
      return reply.status(500).send({ error: { code: 'LEAVE_FAILED', message: 'internal error' } })
    }
    const acc = state.accounts.get(accountId)!
    removeMember(state, groupId, acc.platformUserId)
    return {}
  })

  app.get('/groups/:groupId/members', async (req, reply) => {
    const group = state.groups.get((req.params as { groupId: string }).groupId)
    if (!group) return respond(reply, err(404, 'GROUP_NOT_FOUND'))
    return [...group.members]
  })

  // ── 发消息 ───────────────────────────────────────────────
  app.post('/groups/:groupId/send', async (req, reply) => {
    const g = gatewayGuard(state)
    if (g) return respond(reply, g)
    const { groupId } = req.params as { groupId: string }
    const { accountId, clientMsgId, text } = req.body as { accountId: string; clientMsgId: string; text: string }
    const guard = accountGuard(state, accountId)
    if (guard) return respond(reply, guard)
    const group = state.groups.get(groupId)
    if (!group) return respond(reply, err(404, 'GROUP_NOT_FOUND'))
    if (!clientMsgId) return respond(reply, err(400, 'CLIENT_MSG_ID_REQUIRED'))

    const outcome = planSend(state, groupId, accountId, clientMsgId, text)
    if (outcome.respond.status === 202 || outcome.respond.status === 504) {
      // 504 也可能已接收：照常落地（网关“2 秒内收敛”语义）
      outcome.schedule()
      if (outcome.respond.status === 504) return reply.status(504).send(outcome.respond.body)
      const [min, max] = state.knobs.sendLatencyMs
      const delay = min + Math.floor(Math.random() * (max - min + 1))
      return await new Promise((resolve) => {
        state.timers.add(setTimeout(() => resolve(reply.status(202).send(outcome.respond.body)), delay))
      })
    }
    return respond(reply, outcome.respond)
  })

  app.get('/groups/:groupId/messages/by-client-id/:clientMsgId', async (req, reply) => {
    if (Date.now() < state.knobs.byClientId503Until) return respond(reply, err(503, 'UNAVAILABLE'))
    const { clientMsgId } = req.params as { clientMsgId: string }
    const hit = state.sentLog.find((s) => s.clientMsgId === clientMsgId) // 最早一条
    if (!hit) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'not landed' } })
    return { msgId: hit.msgId, sentAt: hit.sentAt }
  })

  // ── 事件流 ───────────────────────────────────────────────
  app.get('/events', async (req, reply) => {
    const since = Number((req.query as { since?: string }).since ?? 0)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // 关键：writeHead 后必须至少有一次 body write 才会真正刷出头（空历史时不写帧会导致客户端永远等不到响应头）
    reply.raw.write(': connected\n\n')
    const write = (ev: { eventId: number; type: string; data: Record<string, unknown> }) => {
      reply.raw.write(`id: ${ev.eventId}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    }
    for (const ev of state.events) {
      if (ev.eventId > since) write(ev)
    }
    const sub = (ev: { eventId: number; type: string; data: Record<string, unknown> }) => {
      if (ev.eventId > since) write(ev)
    }
    state.subscribers.add(sub)
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
    req.raw.on('close', () => {
      clearInterval(heartbeat)
      state.subscribers.delete(sub)
    })
    return reply
  })

  // ── 测试控制面 ────────────────────────────────────────────
  app.post('/__ctl', async (req) => {
    const { op, ...params } = (req.body ?? {}) as { op: string } & Record<string, unknown>
    return ctl(state, op, params)
  })

  app.get('/__state', async () => ({
    groups: [...state.groups.values()].map((g) => ({ groupId: g.groupId, members: [...g.members], owner: g.owner })),
    sentLog: state.sentLog,
    eventCount: state.events.length,
    maxEventId: state.nextEventId - 1,
    accounts: [...state.accounts.values()].map((a) => ({ accountId: a.accountId, online: a.online, terminal: a.terminal })),
  }))

  return { app, state }
}
