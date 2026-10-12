import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode } from '@mhub/shared'
import { setupTest, teardownTest, type TestCtx } from '../helpers'

let ctx: TestCtx

beforeAll(async () => {
  ctx = await setupTest()
})
afterAll(async () => {
  await teardownTest(ctx)
})

interface LoginResult {
  accessToken: string
  setCookie: string[]
}

async function loginWithCookie(username: string, password: string): Promise<LoginResult> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
  expect(res.statusCode).toBe(200)
  return { accessToken: (res.json() as { accessToken: string }).accessToken, setCookie: res.cookies.map((c) => `${c.name}=${c.value}`) }
}

function refreshCookieOf(result: LoginResult): string {
  const c = result.setCookie.find((s) => s.startsWith('refresh_token='))
  expect(c).toBeTruthy()
  return c!
}

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } }
}

describe('B3 登录会话', () => {
  it('login 下发 HttpOnly cookie（refresh 不进响应体）', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })
    const body = res.json() as Record<string, unknown>
    expect(body.refreshToken).toBeUndefined() // 不放响应体
    const cookie = res.cookies.find((c) => c.name === 'refresh_token')
    expect(cookie).toBeTruthy()
    expect(cookie!.httpOnly).toBe(true)
  })

  it('refresh 轮换：新 access + 新 cookie；旧 refresh 再用 → 401 且整个会话作废', async () => {
    const l1 = await loginWithCookie('admin', 'admin')
    const cookie1 = refreshCookieOf(l1)

    // 第一次 refresh：成功、轮换
    const r1 = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie1 } })
    expect(r1.statusCode).toBe(200)
    const access2 = (r1.json() as { accessToken: string }).accessToken
    expect(access2).toBeTruthy()
    const cookie2raw = r1.cookies.find((c) => c.name === 'refresh_token')
    expect(cookie2raw).toBeTruthy()
    const cookie2 = `${cookie2raw!.name}=${cookie2raw!.value}`
    expect(cookie2).not.toBe(cookie1)

    // access2 可用
    const probe = await ctx.app.inject({ method: 'GET', url: '/api/accounts', ...bearer(access2) })
    expect(probe.statusCode).toBe(200)

    // 旧 refresh 再用 → 401 + 会话作废
    const reuse = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie1 } })
    expect(reuse.statusCode).toBe(401)
    expect(reuse.json().error.code).toBe(ErrorCode.UNAUTHORIZED)

    // 之前换出的 access2 立即失效（整个家族作废）
    const after = await ctx.app.inject({ method: 'GET', url: '/api/accounts', ...bearer(access2) })
    expect(after.statusCode).toBe(401)

    // 新 refresh cookie 也已死
    const r2 = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie2 } })
    expect(r2.statusCode).toBe(401)
  })

  it('正常链式 refresh 可持续换新', async () => {
    const l1 = await loginWithCookie('viewer', 'viewer')
    let cookie = refreshCookieOf(l1)
    for (let i = 0; i < 3; i++) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } })
      expect(r.statusCode).toBe(200)
      const c = r.cookies.find((x) => x.name === 'refresh_token')!
      cookie = `${c.name}=${c.value}`
    }
  })

  it('logout 后同一 access token 立即失效', async () => {
    const l1 = await loginWithCookie('admin', 'admin')
    const ok1 = await ctx.app.inject({ method: 'GET', url: '/api/accounts', ...bearer(l1.accessToken) })
    expect(ok1.statusCode).toBe(200)

    const out = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', ...bearer(l1.accessToken) })
    expect(out.statusCode).toBe(200)

    const ok2 = await ctx.app.inject({ method: 'GET', url: '/api/accounts', ...bearer(l1.accessToken) })
    expect(ok2.statusCode).toBe(401)

    // refresh cookie 也不可用（清除了）
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: refreshCookieOf(l1) } })
    expect(r.statusCode).toBe(401)
  })

  it('无 cookie / 垃圾 cookie → 401', async () => {
    const r1 = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh' })
    expect(r1.statusCode).toBe(401)
    const r2 = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: 'refresh_token=garbage' } })
    expect(r2.statusCode).toBe(401)
  })
})
