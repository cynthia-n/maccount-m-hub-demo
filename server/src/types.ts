import type { Config } from './config'
import type { Db } from './db'

export interface AuthUser {
  userId: string
  username: string
  role: 'admin' | 'viewer'
}

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config
    db: Db
  }
  interface FastifyRequest {
    user?: AuthUser
  }
}
