import { createHash, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError, ErrorCode } from '@mhub/shared'
import type { AuthUser } from '../types'

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m?.[1] ?? null
}

export async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  const token = bearerToken(req)
  if (!token) throw new AppError(401, ErrorCode.UNAUTHORIZED, '缺少 access token')
  const { rows } = await req.server.db.query<{
    user_id: string
    username: string
    role: 'admin' | 'viewer'
    expired: boolean
    revoked: boolean
  }>(
    `SELECT at.user_id, u.username, u.role,
            (at.expires_at < now()) AS expired,
            (s.revoked_at IS NOT NULL) AS revoked
       FROM access_tokens at
       JOIN auth_sessions s ON s.id = at.session_id
       JOIN users u ON u.id = at.user_id
      WHERE at.token_hash = $1`,
    [sha256(token)],
  )
  const row = rows[0]
  if (!row) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'access token 无效')
  if (row.revoked) throw new AppError(401, ErrorCode.UNAUTHORIZED, '会话已失效')
  if (row.expired) throw new AppError(401, ErrorCode.UNAUTHORIZED, 'access token 已过期')
  return { userId: row.user_id, username: row.username, role: row.role }
}

// 路由级守卫：requireAuth() / requireAuth({ admin: true })
export function requireAuth(opts: { admin?: boolean } = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const user = await authenticate(req)
    if (opts.admin && user.role !== 'admin') {
      throw new AppError(403, ErrorCode.FORBIDDEN, '需要 admin 权限')
    }
    req.user = user
  }
}
