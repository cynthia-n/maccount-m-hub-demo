// 网关模拟器状态与行为内核（docs/API.md §2 契约）
// 独立于 Fastify，方便测试直接驱动。

export interface MockKnobs {
  duplicateEvents: number
  reorderWindowMs: number
  sendLatencyMs: [number, number]
  sentLatencyMs: [number, number]
  joinLatencyMs: [number, number]
  kickLatencyMs: [number, number]
  send504Left: number
  leave500Left: number
  kick504Left: number
  inviteMode: 'normal' | 'notReady' | 'expire'
  notReadyMs: number
  byClientId503Until: number
  gateway503Until: number
}

export interface MockAccount {
  accountId: string
  platformUserId: string
  online: boolean
  terminal: null | 'suspended' | 'session_expired'
}

export interface MockGroup {
  groupId: string
  owner: string // platformUserId
  members: Set<string>
  admins: Set<string>
  writeForbidden: boolean
}

export interface MockEvent {
  eventId: number
  type: string
  data: Record<string, unknown>
}

export interface SentRecord {
  clientMsgId: string
  msgId: string
  sentAt: number
  groupId: string
  accountId: string
}

export interface MockState {
  knobs: MockKnobs
  accounts: Map<string, MockAccount>
  groups: Map<string, MockGroup>
  invites: Map<string, { groupId: string; readyAt: number; expiresAt: number | null }>
  events: MockEvent[]
  sentLog: SentRecord[]
  rateLimit: Map<string, { until: number; windowMs: number }>
  silentJoin: Set<string>
  asyncFailQueue: string[] // send 202 后以 message_failed 收场的 code 队列
  subscribers: Set<(ev: MockEvent) => void>
  counters: { invite: number; join: number; promote: number; kick: number; leave: number; send: number }
  nextEventId: number
  nextMsgId: number
  nextGroupId: number
  inviteSeq: number
  timers: Set<ReturnType<typeof setTimeout>>
}

export function createState(seedAccounts: string[]): MockState {
  const state: MockState = {
    knobs: {
      duplicateEvents: 1,
      reorderWindowMs: 0,
      sendLatencyMs: [80, 200],
      sentLatencyMs: [80, 250],
      joinLatencyMs: [80, 300],
      kickLatencyMs: [50, 120],
      send504Left: 0,
      leave500Left: 0,
      kick504Left: 0,
      inviteMode: 'normal',
      notReadyMs: 1500,
      byClientId503Until: 0,
      gateway503Until: 0,
    },
    accounts: new Map(),
    groups: new Map(),
    invites: new Map(),
    events: [],
    sentLog: [],
    rateLimit: new Map(),
    silentJoin: new Set(),
    asyncFailQueue: [],
    subscribers: new Set(),
    counters: { invite: 0, join: 0, promote: 0, kick: 0, leave: 0, send: 0 },
    nextEventId: 1,
    nextMsgId: 1,
    nextGroupId: 1,
    inviteSeq: 1,
    timers: new Set(),
  }
  for (const id of seedAccounts) {
    state.accounts.set(id, { accountId: id, platformUserId: `pu-${id}`, online: false, terminal: null })
  }
  return state
}

function randBetween([min, max]: [number, number]): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function later(state: MockState, ms: number, fn: () => void): void {
  const t = setTimeout(() => {
    state.timers.delete(t)
    fn()
  }, ms)
  state.timers.add(t)
}

/** 事件落历史 + 投递给订阅者。duplicate>1 时每份拷贝都是独立 eventId（对应补投语义）。 */
export function pushEvent(state: MockState, type: string, data: Record<string, unknown>): MockEvent[] {
  const copies: MockEvent[] = []
  const n = Math.max(1, state.knobs.duplicateEvents)
  for (let i = 0; i < n; i++) {
    const eventId = state.nextEventId++
    const ev: MockEvent = { eventId, type, data: { ...data, eventId, type } }
    state.events.push(ev)
    copies.push(ev)
  }
  for (const ev of copies) {
    const delay = state.knobs.reorderWindowMs > 0 ? Math.floor(Math.random() * state.knobs.reorderWindowMs) : 0
    if (delay === 0) {
      for (const sub of state.subscribers) sub(ev)
    } else {
      later(state, delay, () => {
        for (const sub of state.subscribers) sub(ev)
      })
    }
  }
  return copies
}

export function err(status: number, code: string, extra: Record<string, unknown> = {}) {
  return { status, body: { error: { code, message: code, ...extra } } }
}

/** 账号级前置校验：终态/离线。返回 null 或错误响应。 */
export function accountGuard(state: MockState, accountId: string) {
  const acc = state.accounts.get(accountId)
  if (!acc) return err(404, 'ACCOUNT_NOT_FOUND')
  if (acc.terminal === 'suspended') return err(403, 'ACCOUNT_SUSPENDED')
  if (acc.terminal === 'session_expired') return err(401, 'SESSION_EXPIRED')
  if (!acc.online) return err(409, 'ACCOUNT_OFFLINE')
  return null
}

export function gatewayGuard(state: MockState) {
  if (Date.now() < state.knobs.gateway503Until) return err(503, 'GATEWAY_UNAVAILABLE')
  return null
}

export interface SendOutcome {
  respond: { status: number; body: unknown }
  /** 202/504 之后异步执行：落地 message_sent + message（或 message_failed） */
  schedule: () => void
}

export function planSend(state: MockState, groupId: string, accountId: string, clientMsgId: string, text: string): SendOutcome {
  const acc = state.accounts.get(accountId)!
  const group = state.groups.get(groupId)!

  const rate = state.rateLimit.get(accountId)
  if (rate && Date.now() < rate.until) {
    const retryAfterSeconds = Math.max(1, Math.ceil((rate.until - Date.now()) / 1000))
    rate.until = Date.now() + rate.windowMs // 计时重置
    return {
      respond: err(429, 'RATE_LIMITED', { retryAfterSeconds }),
      schedule: () => {},
    }
  }
  if (group.writeForbidden) return { respond: err(403, 'GROUP_WRITE_FORBIDDEN'), schedule: () => {} }
  if (!group.members.has(acc.platformUserId)) return { respond: err(403, 'SENDER_NOT_IN_GROUP'), schedule: () => {} }

  const use504 = state.knobs.send504Left > 0
  if (use504) state.knobs.send504Left -= 1
  const asyncFailCode = state.asyncFailQueue.shift() ?? null

  const land = () => {
    const sentAt = Date.now()
    const msgId = `msg-${state.nextMsgId++}`
    state.sentLog.push({ clientMsgId, msgId, sentAt, groupId, accountId })
    if (asyncFailCode) {
      pushEvent(state, 'message_failed', { clientMsgId, code: asyncFailCode })
      return
    }
    pushEvent(state, 'message_sent', { clientMsgId, msgId, sentAt })
    pushEvent(state, 'message', { groupId, msgId, senderPlatformUserId: acc.platformUserId, text, sentAt })
  }

  const sendDelay = randBetween(state.knobs.sendLatencyMs)
  return {
    respond: use504 ? { status: 504, body: { error: { code: 'NETWORK_TIMEOUT', message: 'upstream timeout' } } } : { status: 202, body: { accepted: true } },
    schedule: () => {
      const sentDelay = use504 ? Math.min(state.knobs.sentLatencyMs[1], 2000) : randBetween(state.knobs.sentLatencyMs)
      later(state, sentDelay, land)
    },
  }
}

export function kickTarget(state: MockState, groupId: string, byAccountId: string, targetPlatformUserId: string) {
  const group = state.groups.get(groupId)
  if (!group) return err(404, 'GROUP_NOT_FOUND')
  const by = state.accounts.get(byAccountId)
  if (!by) return err(404, 'ACCOUNT_NOT_FOUND')
  if (by.terminal) return by.terminal === 'suspended' ? err(403, 'ACCOUNT_SUSPENDED') : err(401, 'SESSION_EXPIRED')
  if (!by.online) return err(409, 'ACCOUNT_OFFLINE')
  if (!group.members.has(group.owner)) return err(409, 'OWNER_LEFT')
  const isOwner = group.owner === by.platformUserId
  if (!isOwner && !group.admins.has(by.platformUserId)) return err(403, 'NO_PERMISSION')
  return null
}

/** 仅从成员表摘除（不推事件）；返回是否真的发生了移除 */
export function detachMember(state: MockState, groupId: string, platformUserId: string): boolean {
  const group = state.groups.get(groupId)
  if (!group) return false
  if (!group.members.delete(platformUserId)) return false
  group.admins.delete(platformUserId)
  return true
}

/** 推 member_left（幂等防御：群不存在则忽略） */
export function pushMemberLeft(state: MockState, groupId: string, platformUserId: string): void {
  if (state.groups.has(groupId)) {
    pushEvent(state, 'member_left', { groupId, platformUserId })
  }
}

/** 成员离开（leave 场景）：摘除 + 立即推事件 */
export function removeMember(state: MockState, groupId: string, platformUserId: string): void {
  if (detachMember(state, groupId, platformUserId)) {
    pushMemberLeft(state, groupId, platformUserId)
  }
}

/** account_status 事件：终态化 + 移出所有群（题面 §2.1） */
export function terminateAccount(state: MockState, accountId: string, status: 'suspended' | 'session_expired'): void {
  const acc = state.accounts.get(accountId)
  if (!acc) return
  acc.terminal = status
  acc.online = false
  pushEvent(state, 'account_status', { accountId, status })
  for (const group of [...state.groups.values()]) {
    if (group.members.has(acc.platformUserId)) {
      detachMember(state, group.groupId, acc.platformUserId)
      pushMemberLeft(state, group.groupId, acc.platformUserId)
    }
  }
}

export function ctl(state: MockState, op: string, params: Record<string, unknown>): unknown {
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d)
  switch (op) {
    case 'setDuplicateEvents':
      state.knobs.duplicateEvents = num(params.n, 1)
      return { ok: true }
    case 'setReorderWindowMs':
      state.knobs.reorderWindowMs = num(params.ms, 0)
      return { ok: true }
    case 'setSendLatencyMs':
      state.knobs.sendLatencyMs = [num(params.min, 80), num(params.max, 200)]
      return { ok: true }
    case 'setSentLatencyMs':
      state.knobs.sentLatencyMs = [num(params.min, 80), num(params.max, 250)]
      return { ok: true }
    case 'setJoinLatencyMs':
      state.knobs.joinLatencyMs = [num(params.min, 80), num(params.max, 300)]
      return { ok: true }
    case 'setKickLatencyMs':
      state.knobs.kickLatencyMs = [num(params.min, 50), num(params.max, 120)]
      return { ok: true }
    case 'setSend504':
      state.knobs.send504Left = num(params.count, 1)
      return { ok: true }
    case 'setKick504':
      state.knobs.kick504Left = num(params.count, 1)
      return { ok: true }
    case 'setLeave500':
      state.knobs.leave500Left = num(params.count, 1)
      return { ok: true }
    case 'setRateLimit': {
      const windowMs = num(params.retryAfterSeconds, 1) * 1000
      state.rateLimit.set(String(params.accountId), { until: Date.now() + windowMs, windowMs })
      return { ok: true }
    }
    case 'suspendAccount':
      terminateAccount(state, String(params.accountId), 'suspended')
      return { ok: true }
    case 'expireSession':
      terminateAccount(state, String(params.accountId), 'session_expired')
      return { ok: true }
    case 'offlineRedeliver': {
      const accountId = String(params.accountId)
      const acc = state.accounts.get(accountId)
      const last = [...state.sentLog].reverse().find((s) => s.accountId === accountId)
      if (!acc || !last) return { ok: false, reason: 'no sent message' }
      later(state, num(params.delayMs, 100), () => {
        pushEvent(state, 'message', {
          groupId: last.groupId,
          msgId: last.msgId,
          senderPlatformUserId: acc.platformUserId,
          text: '(redelivered)',
          sentAt: last.sentAt,
        })
      })
      return { ok: true }
    }
    case 'setInvite': {
      state.knobs.inviteMode = (params.mode as MockKnobs['inviteMode']) ?? 'normal'
      state.knobs.notReadyMs = num(params.readyAfterMs, 1500)
      return { ok: true }
    }
    case 'setJoinSilent':
      state.silentJoin.add(String(params.accountId))
      return { ok: true }
    case 'setByClientId503':
      state.knobs.byClientId503Until = Date.now() + num(params.ms, 1000)
      return { ok: true }
    case 'setGateway503':
      state.knobs.gateway503Until = Date.now() + num(params.ms, 1000)
      return { ok: true }
    case 'setGroupWriteForbidden': {
      const group = state.groups.get(String(params.groupId))
      if (group) group.writeForbidden = true
      return { ok: true }
    }
    case 'setSendAsyncFail':
      for (let i = 0; i < num(params.count, 1); i++) state.asyncFailQueue.push(String(params.code))
      return { ok: true }
    case 'emit': {
      // 测试注入任意事件（inbox 管线测试用）
      pushEvent(state, String(params.type), (params.data as Record<string, unknown>) ?? {})
      return { ok: true }
    }
    default:
      return err(400, 'UNKNOWN_CTL_OP', { op })
  }
}
