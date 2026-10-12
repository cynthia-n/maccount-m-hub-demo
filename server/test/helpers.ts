import type { FastifyInstance } from 'fastify'
import { loadConfig, type Config } from '../src/config'
import { createDb, type Db } from '../src/db'
import { freshDatabase, EXPECTED_SCHEMA_VERSION } from '../src/migrate'
import { ensureSeed } from '../src/seed'
import { buildApp } from '../src/app'

// 集成测试基座：测试库全新迁移 + 进程内 app（fastify.inject 调用，不占端口）
export interface TestCtx {
  cfg: Config
  db: Db
  app: FastifyInstance
}

export async function setupTest(): Promise<TestCtx> {
  const cfg = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_TEST_URL ?? 'postgres://maccount:maccount@127.0.0.1:54329/maccount_test',
    // 测试内不真正使用；短 TTL 备后续里程碑
    ACCESS_TOKEN_TTL_MS: '2000',
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

export const SCHEMA_VERSION = EXPECTED_SCHEMA_VERSION

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
