// API 客户端：access token 内存 + localStorage；401 单飞刷新（B3：多个请求同时 401 只发一次 refresh）
import { useSyncExternalStore } from 'react'

export interface AuthState {
  accessToken: string | null
  role: 'admin' | 'viewer' | null
}

const KEY = 'mhub.auth'
let state: AuthState = load()
const listeners = new Set<() => void>()

function load(): AuthState {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '') as AuthState
  } catch {
    return { accessToken: null, role: null }
  }
}

function set(next: AuthState): void {
  state = next
  if (next.accessToken) localStorage.setItem(KEY, JSON.stringify(next))
  else localStorage.removeItem(KEY)
  for (const l of listeners) l()
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}

export const auth = {
  get: () => state,
  signIn(accessToken: string, role: 'admin' | 'viewer') {
    set({ accessToken, role })
  },
  signOut() {
    set({ accessToken: null, role: null })
  },
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
  }
}

let refreshing: Promise<boolean> | null = null

async function singleFlightRefresh(): Promise<boolean> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (!res.ok) return false
      const body = (await res.json()) as { accessToken: string }
      set({ ...state, accessToken: body.accessToken })
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export async function api<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
  opts: { retry?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (state.accessToken) headers.authorization = `Bearer ${state.accessToken}`

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })
  if (res.status === 401 && !url.startsWith('/api/auth/login') && opts.retry !== false) {
    const refreshed = await singleFlightRefresh()
    if (refreshed) return api<T>(method, url, body, { retry: false })
    auth.signOut()
  }
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
  }
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (parsed as any)?.error ?? {}
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? res.statusText, err)
  }
  return parsed as T
}

export const http = {
  get: <T,>(url: string) => api<T>('GET', url),
  post: <T,>(url: string, body?: unknown) => api<T>('POST', url, body),
  patch: <T,>(url: string, body?: unknown) => api<T>('PATCH', url, body),
}
