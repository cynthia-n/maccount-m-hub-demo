import fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { AppError, ErrorCode, toErrorBody } from '@mhub/shared'
import type { Config } from './config'
import type { Db } from './db'
import { GatewayClient } from './gateway/client'
import { accountRoutes } from './routes/accounts'
import { agentRunRoutes } from './routes/agent-runs'
import { authRoutes } from './routes/auth'
import { groupRoutes } from './routes/groups'
import { healthRoutes } from './routes/health'
import { jobRoutes } from './routes/jobs'
import { sequenceRoutes } from './routes/sequences'
import './types'

export interface BuildOptions {
  logger?: boolean
  // 测试可注入额外路由（如守卫探针），不进入交付路由表
  extras?: (app: FastifyInstance) => void
}

export async function buildApp(cfg: Config, db: Db, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = fastify({
    logger: opts.logger ?? false,
    genReqId: () => randomUUID(),
  })
  app.decorate('cfg', cfg)
  app.decorate('db', db)
  app.decorate('gateway', new GatewayClient(cfg.GATEWAY_URL))

  // 统一错误出口：一切错误都是 { error: { code, message, requestId, ... } }
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(toErrorBody(err, req.id))
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: '请求参数不合法',
          requestId: req.id,
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      })
    }
    // fastify 自身产生的 4xx（JSON 解析失败、body 为空等）
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: err.message,
          requestId: req.id,
        },
      })
    }
    req.log.error(err)
    return reply.status(500).send({
      error: { code: ErrorCode.INTERNAL, message: '内部错误', requestId: req.id },
    })
  })

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: ErrorCode.NOT_FOUND, message: '路由不存在', requestId: req.id },
    })
  })

  healthRoutes(app)
  authRoutes(app)
  accountRoutes(app)
  groupRoutes(app)
  agentRunRoutes(app)
  jobRoutes(app)
  sequenceRoutes(app)
  opts.extras?.(app)

  await app.ready()
  return app
}
