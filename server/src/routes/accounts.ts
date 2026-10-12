import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ACCOUNT_STATUSES, AppError, ErrorCode, type AccountStatus } from '@mhub/shared'
import { requireAuth } from '../plugins/auth'
import { applyAccountTransition } from '../domain/accounts'
import { emitWs } from '../ws/outbox'
import { GatewayError, GatewayUnavailable } from '../gateway/client'

const transitionBody = z.object({
  to: z.enum(ACCOUNT_STATUSES),
  expectedFrom: z.enum(ACCOUNT_STATUSES),
})

export function accountRoutes(app: FastifyInstance) {
  app.get('/api/accounts', { preHandler: [requireAuth()] }, async () => {
    const { rows } = await app.db.query<{
      id: string
      status: AccountStatus
      platform_user_id: string | null
      rate_limited_until: Date | null
    }>('SELECT id, status, platform_user_id, rate_limited_until FROM accounts ORDER BY id')
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      platformUserId: r.platform_user_id,
      rateLimitedUntil: r.rate_limited_until ? r.rate_limited_until.toISOString() : null,
    }))
  })

  app.post('/api/accounts/:id/connect', { preHandler: [requireAuth({ admin: true })] }, async (req) => {
    const accountId = (req.params as { id: string }).id
    const { rows } = await app.db.query<{ status: AccountStatus; platform_user_id: string | null }>(
      'SELECT status, platform_user_id FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId],
    )
    const acc = rows[0]
    if (!acc) throw new AppError(404, ErrorCode.ACCOUNT_NOT_FOUND, '账号不存在')
    if (acc.status === 'suspended' || acc.status === 'session_expired') {
      throw new AppError(409, ErrorCode.ILLEGAL_TRANSITION, '终态账号不能重连')
    }
    if (acc.status === 'online') {
      return { status: 'online', platformUserId: acc.platform_user_id }
    }

    let platformUserId: string
    try {
      const res = await app.gateway.connect(accountId)
      platformUserId = res.body.platformUserId
    } catch (e) {
      if (e instanceof GatewayError && (e.code === 'ACCOUNT_SUSPENDED' || e.code === 'SESSION_EXPIRED')) {
        // 网关说账号已终态：先落我们的状态（副作用一致），再报给操作员
        await applyAccountTransition(app.db, {
          accountId,
          to: e.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired',
          source: 'gateway_event',
        })
        throw new AppError(409, e.code, '网关报告账号已终态')
      }
      throw new AppError(502, 'GATEWAY_UNAVAILABLE', '网关不可用')
    }

    // idle/disconnected/rate_limited → online（CAS：并发时只允许一个成功）
    const result = await app.db.withTx(async (q) => {
      const r = await q(
        `UPDATE accounts SET status = 'online', platform_user_id = $2, rate_limited_until = NULL, last_transition_at = now()
         WHERE id = $1 AND status IN ('idle','disconnected','rate_limited')`,
        [accountId, platformUserId],
      )
      if (r.rowCount === 1) {
        await emitWs(q, 'account_status_changed', { accountId, from: acc.status, to: 'online' })
      }
      return r.rowCount
    })
    if (result !== 1) {
      // 并发 connect / 期间被操作员改动：重读返回当前状态
      const { rows: again } = await app.db.query<{ status: AccountStatus; platform_user_id: string | null }>(
        'SELECT status, platform_user_id FROM accounts WHERE id = $1',
        [accountId],
      )
      if (again[0]?.status === 'online') return { status: 'online', platformUserId: again[0].platform_user_id }
      throw new AppError(409, ErrorCode.CAS_CONFLICT, '账号状态已变化，请刷新后重试')
    }
    return { status: 'online', platformUserId }
  })

  app.post('/api/accounts/:id/transition', { preHandler: [requireAuth({ admin: true })] }, async (req) => {
    const accountId = (req.params as { id: string }).id
    const body = transitionBody.parse(req.body)
    const result = await applyAccountTransition(app.db, {
      accountId,
      to: body.to,
      source: 'operator',
      expectedFrom: body.expectedFrom,
    })
    if (!result.ok) {
      if (result.reason === 'not_found') throw new AppError(404, ErrorCode.ACCOUNT_NOT_FOUND, '账号不存在')
      if (result.reason === 'cas_conflict') throw new AppError(409, ErrorCode.CAS_CONFLICT, '账号当前状态已不是 expectedFrom')
      throw new AppError(409, ErrorCode.ILLEGAL_TRANSITION, `${body.expectedFrom} → ${body.to} 不在转移表上`)
    }
    // 标为 disconnected/idle 时调网关 disconnect（本地状态已提交，网关失败仅记录）
    if (body.to === 'disconnected' || body.to === 'idle') {
      try {
        await app.gateway.disconnect(accountId)
      } catch (e) {
        if (e instanceof GatewayUnavailable || (e instanceof GatewayError && e.retryable)) {
          req.log.warn({ accountId, err: String(e) }, 'gateway disconnect failed')
        }
        // ACCOUNT_OFFLINE / 终态等业务错误：忽略
      }
    }
    return { status: body.to }
  })
}
