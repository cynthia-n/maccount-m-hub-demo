import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@mhub/shared'
import { newToken, requireAuth, sha256 } from '../plugins/auth'
import { verifyPassword } from '../passwords'

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const REFRESH_COOKIE = 'refresh_token'

function cookieHeader(req: { headers: { cookie?: string | string[] } }): Record<string, string> {
  const raw = req.headers.cookie
  const out: Record<string, string> = {}
  for (const part of (Array.isArray(raw) ? raw.join(';') : raw ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function setRefreshCookie(reply: { header: (k: string, v: string) => unknown }, token: string, maxAgeSec: number): void {
  reply.header(
    'set-cookie',
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=${maxAgeSec}`,
  )
}

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = loginBody.parse(req.body)
    const { rows } = await app.db.query<{ id: string; password_hash: string; role: 'admin' | 'viewer' }>(
      'SELECT id, password_hash, role FROM users WHERE username = $1',
      [body.username],
    )
    const user = rows[0]
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw new AppError(401, ErrorCode.UNAUTHORIZED, '用户名或密码错误')
    }
    const accessToken = newToken()
    const refreshToken = newToken()
    await app.db.withTx(async (q) => {
      const session = await q<{ id: string }>(
        'INSERT INTO auth_sessions (user_id) VALUES ($1) RETURNING id',
        [user.id],
      )
      const sessionId = session.rows[0]!.id
      await q(
        `INSERT INTO access_tokens (token_hash, session_id, user_id, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [sha256(accessToken), sessionId, user.id, app.cfg.ACCESS_TOKEN_TTL_MS / 1000],
      )
      await q(
        `INSERT INTO refresh_tokens (token_hash, session_id, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))`,
        [sha256(refreshToken), sessionId, app.cfg.REFRESH_TTL_MS / 1000],
      )
    })
    setRefreshCookie(reply, refreshToken, app.cfg.REFRESH_TTL_MS / 1000)
    return { accessToken, role: user.role }
  })

  // B3 refresh：轮换 + 重用检测（旧 token 再用 → 401 且整个会话家族作废）
  app.post('/api/auth/refresh', async (req, reply) => {
    const presented = cookieHeader(req)[REFRESH_COOKIE]
    if (!presented) throw new AppError(401, ErrorCode.UNAUTHORIZED, '缺少 refresh token')
    const hash = sha256(presented)
    const { rows } = await app.db.query<{
      id: string
      session_id: string
      user_id: string
      status: string
      expired: boolean
      session_revoked: boolean
    }>(
      `SELECT rt.id, rt.session_id, s.user_id, rt.status,
              (rt.expires_at < now()) AS expired,
              (s.revoked_at IS NOT NULL) AS session_revoked
         FROM refresh_tokens rt JOIN auth_sessions s ON s.id = rt.session_id
        WHERE rt.token_hash = $1`,
      [hash],
    )
    const row = rows[0]
    if (!row || row.session_revoked) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'refresh token 无效')
    if (row.expired) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'refresh token 已过期')
    if (row.status === 'rotated') {
      // 重用检测：已轮换的 token 再次出现 → 撤销整个会话（之前换出的所有 token 立即失效）
      await app.db.query(
        `UPDATE auth_sessions SET revoked_at=now(), revoked_reason='refresh_reuse' WHERE id=$1 AND revoked_at IS NULL`,
        [row.session_id],
      )
      throw new AppError(401, ErrorCode.UNAUTHORIZED, 'refresh token 已被使用，会话已作废')
    }

    const accessToken = newToken()
    const refreshToken = newToken()
    await app.db.withTx(async (q) => {
      await q(`UPDATE refresh_tokens SET status='rotated' WHERE id=$1`, [row.id])
      await q(
        `INSERT INTO refresh_tokens (token_hash, session_id, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))`,
        [sha256(refreshToken), row.session_id, app.cfg.REFRESH_TTL_MS / 1000],
      )
      await q(
        `INSERT INTO access_tokens (token_hash, session_id, user_id, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [sha256(accessToken), row.session_id, row.user_id, app.cfg.ACCESS_TOKEN_TTL_MS / 1000],
      )
    })
    setRefreshCookie(reply, refreshToken, app.cfg.REFRESH_TTL_MS / 1000)
    return { accessToken }
  })

  // B3 logout：会话撤销 → 同一 access token 立即失效
  app.post('/api/auth/logout', { preHandler: [requireAuth()] }, async (req, reply) => {
    const user = req.user!
    await app.db.query(
      `UPDATE auth_sessions SET revoked_at=now(), revoked_reason='logout'
       WHERE id = (SELECT session_id FROM access_tokens WHERE token_hash=$1)
         AND revoked_at IS NULL`,
      [sha256(bearerOf(req) ?? '')],
    )
    void user
    reply.header('set-cookie', `${REFRESH_COOKIE}=; HttpOnly; Path=/api/auth; Max-Age=0`)
    return { ok: true }
  })

  function bearerOf(req: { headers: { authorization?: string | string[] } }): string | null {
    const h = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization
    const m = /^Bearer\s+(.+)$/i.exec(h ?? '')
    return m?.[1] ?? null
  }
}
