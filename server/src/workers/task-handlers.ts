import { applyAccountTransition } from '../domain/accounts'
import { handleJoinTimeout, resumeJob } from '../domain/jobs'
import type { Db } from '../db'
import type { GatewayClient } from '../gateway/client'
import type { DueTaskHandler } from './due-tasks'

// 所有"到点做某事"的实现。handler 收到的是 DB 里的 payload；执行前自行重查状态（状态可能已被别的路径改掉）。
export function dueTaskHandlers(gateway?: GatewayClient): Record<string, DueTaskHandler> {
  return {
    // A1：限流到期恢复——到期时账号必须仍是 rate_limited 才转回 online
    rate_limit_expire: async (db: Db, payload) => {
      const accountId = String(payload.accountId)
      const { rows } = await db.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId])
      if (rows[0]?.status !== 'rate_limited') return
      await applyAccountTransition(db, { accountId, to: 'online', source: 'rate_limit_expiry' })
    },

    // A3 建群 job 等待点唤醒
    job_advance: async (db, payload) => {
      if (!gateway) return
      await resumeJob(db, String(payload.jobId), gateway, payload.waiting ? String(payload.waiting) : undefined)
    },
    job_invite_ready: async (db, payload) => {
      if (!gateway) return
      await resumeJob(db, String(payload.jobId), gateway, 'invite_ready')
    },
    job_join_timeout: async (db, payload) => {
      await handleJoinTimeout(db, String(payload.jobId), String(payload.accountId))
    },
  }
}
