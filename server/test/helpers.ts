import type { FastifyInstance } from 'fastify'
import { loadConfig, type Config } from '../src/config'
import { createDb, type Db } from '../src/db'
import { freshDatabase, EXPECTED_SCHEMA_VERSION } from '../src/migrate'
import { ensureSeed } from '../src/seed'
import { buildApp } from '../src/app'
import { startRuntime, type Runtime } from '../src/runtime'
import { buildGatewayMock } from '../../mocks/gateway/src/app'
import type { MockState } from '../../mocks/gateway/src/state'

export const SCHEMA_VERSION = EXPECTED_SCHEMA_VERSION

export async function listenUrl(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return `http://127.0.0.1:${port}`
}

// 集成测试基座：测试库全新迁移 + 进程内 app（fastify.inject 调用，不占端口）
export interface TestCtx {
  cfg: Config
  db: Db
  app: FastifyInstance
}

export async function setupTest(): Promise<TestCtx> {
  // advanceJob 等 domain 层直接读进程环境变量，这里统一成测试时序
  process.env.JOIN_TIMEOUT_MS ??= '2000'
  const cfg = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_TEST_URL ?? 'postgres://maccount:maccount@127.0.0.1:54329/maccount_test',
    ACCESS_TOKEN_TTL_MS: '60000',
    JOIN_TIMEOUT_MS: '2000',
  })
  const db = createDb(cfg.DATABASE_URL)
  await freshDatabase(db)
  await ensureSeed(db)
  const app = await buildApp(cfg, db)
  return { cfg, db, app }
}

export async function teardownTest(ctx: TestCtx): Promise<void> {
  await ctx.app.close()
  await ctx.db.close()
}

// 网关 mock：临时端口 + 控制面便捷方法
export interface MockCtx {
  state: MockState
  url: string
  ctl: (op: string, params?: Record<string, unknown>) => Promise<unknown>
  stateDump: <T = Record<string, unknown>>() => Promise<T>
  close: () => Promise<void>
}

export async function startGatewayMock(seedAccounts?: string[]): Promise<MockCtx> {
  const { app, state } = buildGatewayMock({ seedAccounts })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    ctl: async (op, params = {}) => {
      const res = await app.inject({ method: 'POST', url: '/__ctl', payload: { op, ...params } })
      return res.json()
    },
    stateDump: async <T,>() => {
      const res = await app.inject({ method: 'GET', url: '/__state' })
      return res.json() as T
    },
    close: () => app.close(),
  }
}

/** 轮询等待条件成立（禁止盲目 sleep 的标准替代） */
export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000)
  for (;;) {
    const v = await fn()
    if (v !== null && v !== undefined && v !== false) return v
    if (Date.now() > deadline) throw new Error('pollUntil 超时')
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 50))
  }
}

export async function login(ctx: TestCtx, username: string, password: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  if (res.statusCode !== 200) throw new Error(`login ${username} 失败: ${res.body}`)
  return (res.json() as { accessToken: string }).accessToken
}

export function authed(ctx: TestCtx, token: string) {
  const headers = { authorization: `Bearer ${token}` }
  return {
    get: (url: string) => ctx.app.inject({ method: 'GET', url, headers }),
    post: (url: string, payload?: object) =>
      ctx.app.inject({ method: 'POST', url, payload: payload as Record<string, never>, headers }),
    patch: (url: string, payload?: object) =>
      ctx.app.inject({ method: 'PATCH', url, payload: payload as Record<string, never>, headers }),
  }
}

// 完整运行时测试基座：app + 网关 mock + SSE/inbox/due-tasks/ws-notifier 全部在进程内跑
export interface RuntimeCtx extends TestCtx {
  mock: MockCtx
  runtime: Runtime
}

export async function setupRuntimeTest(opts: { seedAccounts?: string[] } = {}): Promise<RuntimeCtx> {
  const mock = await startGatewayMock(opts.seedAccounts)
  const ctx = await setupTest()
  ctx.cfg.GATEWAY_URL = mock.url
  // rebuild app with correct gateway url（buildApp 已装饰，换 app）
  await ctx.app.close()
  const app = await buildApp(ctx.cfg, ctx.db)
  ctx.app = app
  const runtime = startRuntime(app)
  return { ...ctx, mock, runtime }
}

export async function teardownRuntimeTest(ctx: RuntimeCtx): Promise<void> {
  await ctx.runtime.stop()
  await ctx.mock.close()
  await teardownTest(ctx)
}
