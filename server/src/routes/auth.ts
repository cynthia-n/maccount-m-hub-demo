import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@mhub/shared'
import { newToken, sha256 } from '../plugins/auth'
import { verifyPassword } from '../passwords'

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req) => {
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
    await app.db.withTx(async (q) => {
      const session = await q<{ id: string }>(
        'INSERT INTO auth_sessions (user_id) VALUES ($1) RETURNING id',
        [user.id],
      )
      await q(
        `INSERT INTO access_tokens (token_hash, session_id, user_id, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [sha256(accessToken), session.rows[0]!.id, user.id, app.cfg.ACCESS_TOKEN_TTL_MS / 1000],
      )
    })
    return { accessToken, role: user.role }
  })
}
