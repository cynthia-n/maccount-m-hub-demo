import { applyAccountTransition } from '../domain/accounts'
import { handleJoinTimeout, resumeJob } from '../domain/jobs'
import { runSequenceStep } from '../domain/sequence'
import { scheduleTaskIn, type DueTaskHandler } from './due-tasks'
import type { Db } from '../db'
import type { GatewayClient } from '../gateway/client'

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
    job_advance: async (db: Db, payload) => {
      if (!gateway) return
      await resumeJob(db, String(payload.jobId), gateway, payload.waiting ? String(payload.waiting) : undefined)
    },
    job_invite_ready: async (db: Db, payload) => {
      if (!gateway) return
      await resumeJob(db, String(payload.jobId), gateway, 'invite_ready')
    },
    job_join_timeout: async (db: Db, payload) => {
      await handleJoinTimeout(db, String(payload.jobId), String(payload.accountId))
    },

    // B1 序列步骤到点
    sequence_step: async (db: Db, payload) => {
      await runSequenceStep(db, String(payload.runId), Number(payload.stepIndex))
    },
    // B2 leave 500 后的重试
    leave_retry: async (db: Db, payload) => {
      if (!gateway) return
      await resumeJob(db, String(payload.jobId), gateway, 'leave_retry')
    },

    // A5.2 60s 墙钟兜底：重启时 deadline 会被心跳差值平移，到点先核对剩余时间与工具执行状态
    agent_deadline: async (db: Db, payload) => {
      const runId = String(payload.runId)
      const { rows } = await db.query<{ status: string; deadline_at: Date; pending_action: unknown }>(
        'SELECT status, deadline_at, pending_action FROM agent_runs WHERE id=$1',
        [runId],
      )
      const run = rows[0]
      if (!run || run.status !== 'running') return
      const remaining = new Date(run.deadline_at).getTime() - Date.now()
      if (remaining > 0) {
        await db.withTx((q) => scheduleTaskIn(q, 'agent_deadline', remaining, { runId }))
        return
      }
      if (run.pending_action) {
        // 工具执行中：外部效果一致性优先，稍后再查
        await db.withTx((q) => scheduleTaskIn(q, 'agent_deadline', 2000, { runId }))
        return
      }
      await db.query(
        `UPDATE agent_runs SET status='failed', end_reason='wall_clock', updated_at=now()
         WHERE id=$1 AND status='running'`,
        [runId],
      )
    },
  }
}
