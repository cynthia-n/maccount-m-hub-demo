// Agent 服务 HTTP 客户端：超时竞速 + 原始响应体透传（校验在 domain 层）
export interface AgentTurnResponse {
  ok: true
  raw: string
}
export interface AgentTurnFailure {
  ok: false
  reason: 'timeout' | 'http' | 'network'
  status?: number
  raw: string
}

export class AgentClient {
  constructor(private readonly baseUrl: string) {}

  async turn(
    runId: string,
    tools: unknown,
    messages: unknown,
    timeoutMs: number,
  ): Promise<AgentTurnResponse | AgentTurnFailure> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/agent/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, tools, messages }),
        signal: ac.signal,
      })
      const raw = await res.text()
      if (!res.ok) return { ok: false, reason: 'http', status: res.status, raw }
      return { ok: true, raw }
    } catch (e) {
      if (ac.signal.aborted) return { ok: false, reason: 'timeout', raw: '' }
      return { ok: false, reason: 'network', raw: String(e) }
    } finally {
      clearTimeout(timer)
    }
  }

  async audit(
    text: string,
    groupId: string,
    timeoutMs: number,
  ): Promise<{ ok: true; verdict: string; reason?: string } | { ok: false }> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/agent/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, groupId }),
        signal: ac.signal,
      })
      if (!res.ok) return { ok: false }
      const body = (await res.json()) as { verdict?: unknown; reason?: unknown }
      if (typeof body.verdict !== 'string') return { ok: false }
      return { ok: true, verdict: body.verdict, reason: typeof body.reason === 'string' ? body.reason : undefined }
    } catch {
      return { ok: false }
    } finally {
      clearTimeout(timer)
    }
  }
}
