import { applyAccountTransition } from '../domain/accounts'
import type { Db } from '../db'
import type { DueTaskHandler } from './due-tasks'

// 所有"到点做某事"的实现。handler 收到的是 DB 里的 payload；执行前自行重查状态（状态可能已被别的路径改掉）。
export function dueTaskHandlers(): Record<string, DueTaskHandler> {
  return {
    // A1：限流到期恢复——到期时账号必须仍是 rate_limited 才转回 online
    rate_limit_expire: async (db: Db, payload) => {
      const accountId = String(payload.accountId)
      const { rows } = await db.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId])
      if (rows[0]?.status !== 'rate_limited') return
      await applyAccountTransition(db, { accountId, to: 'online', source: 'rate_limit_expiry' })
    },
  }
}
