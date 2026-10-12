import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ErrorCode } from '@mhub/shared'
import { buildApp } from '../../src/app'
import { requireAuth } from '../../src/plugins/auth'
import { SCHEMA_VERSION, setupTest, teardownTest, type TestCtx } from '../helpers'

let ctx: TestCtx

beforeAll(async () => {
  ctx = await setupTest()
})
afterAll(async () => {
  await teardownTest(ctx)
})

describe('A0 健康检查与版本门禁', () => {
  it('GET /api/health 返回 schemaVersion', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, schemaVersion: SCHEMA_VERSION })
  })
})

describe('A0 登录与 RBAC', () => {
  it('admin/viewer 可登录并拿到 token', async () => {
    for (const [u, p] of [['admin', 'admin'], ['viewer', 'viewer']] as const) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(typeof body.accessToken).toBe('string')
      expect(body.accessToken.length).toBeGreaterThan(32)
    }
  })

  it('错误密码 → 401 UNAUTHORIZED', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope' } })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe(ErrorCode.UNAUTHORIZED)
  })

  it('参数缺失 → 400 VALIDATION_ERROR', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(ErrorCode.VALIDATION_ERROR)
  })

  it('非法 JSON body → 400 VALIDATION_ERROR（统一错误格式）', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: '{bad json',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(ErrorCode.VALIDATION_ERROR)
    expect(res.json().error.requestId).toBeTruthy()
  })
})

// 探针路由只挂在测试子应用上，不进入交付路由表
async function withProbe<T>(fn: (app: FastifyInstance) => Promise<T>): Promise<T> {
  const app = await buildApp(ctx.cfg, ctx.db, {
    extras: (a) => {
      a.get('/api/__probe', { preHandler: [requireAuth({ admin: true })] }, async () => ({ ok: true }))
      a.post('/api/__probe-write', { preHandler: [requireAuth()] }, async () => ({ ok: true }))
    },
  })
  try {
    return await fn(app)
  } finally {
    await app.close()
  }
}

describe('A0 守卫：401/403', () => {
  it('无 token / 假 token → 401 UNAUTHORIZED', async () => {
    await withProbe(async (app) => {
      const no = await app.inject({ method: 'GET', url: '/api/__probe' })
      expect(no.statusCode).toBe(401)
      expect(no.json().error.code).toBe(ErrorCode.UNAUTHORIZED)

      const bad = await app.inject({ method: 'GET', url: '/api/__probe', headers: { authorization: 'Bearer deadbeef' } })
      expect(bad.statusCode).toBe(401)
    })
  })

  it('viewer 访问 admin 路由 → 403 FORBIDDEN（直接调接口也被拦）', async () => {
    await withProbe(async (app) => {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'viewer', password: 'viewer' } })
      const token = login.json().accessToken as string
      const res = await app.inject({ method: 'GET', url: '/api/__probe', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe(ErrorCode.FORBIDDEN)
    })
  })

  it('admin 访问 admin 路由 → 200', async () => {
    await withProbe(async (app) => {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })
      const token = login.json().accessToken as string
      const res = await app.inject({ method: 'GET', url: '/api/__probe', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(200)
    })
  })

  it('viewer 可访问仅需登录的路由', async () => {
    await withProbe(async (app) => {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'viewer', password: 'viewer' } })
      const token = login.json().accessToken as string
      const res = await app.inject({ method: 'POST', url: '/api/__probe-write', headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode).toBe(200)
    })
  })

  it('404 也返回统一错误格式且带 requestId', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/__nope' })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND)
    expect(typeof body.error.requestId).toBe('string')
    expect(body.error.requestId.length).toBeGreaterThan(0)
  })
})
