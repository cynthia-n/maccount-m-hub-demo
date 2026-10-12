import type { Config } from './config'
import type { Db } from './db'
import type { GatewayClient } from './gateway/client'

export interface AuthUser {
  userId: string
  username: string
  role: 'admin' | 'viewer'
}

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config
    db: Db
    gateway: GatewayClient
  }
  interface FastifyRequest {
    user?: AuthUser
  }
}
