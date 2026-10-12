// A1 账号状态机：唯一事实来源。后端校验与前端按钮渲染共用。
// 行=当前状态；同状态到同状态一律不允许（终态重复进入的静默幂等在服务端入口特判）。

export const ACCOUNT_STATUSES = [
  'idle',
  'online',
  'rate_limited',
  'disconnected',
  'suspended',
  'session_expired',
] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

export const TERMINAL_STATUSES: readonly AccountStatus[] = ['suspended', 'session_expired']

// 对照题面 A1 转移表逐格录入
const ALLOWED: Record<AccountStatus, readonly AccountStatus[]> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
}

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function transitionsFrom(from: AccountStatus): readonly AccountStatus[] {
  return ALLOWED[from]
}

export function isTerminal(status: AccountStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}
