// 网关 HTTP 客户端：统一错误形状。503 与网络错误抛 GatewayUnavailable 供上层重试决策。
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
  get retryable(): boolean {
    return this.status === 503 || this.status === 504 || this.status >= 500
  }
}

export class GatewayUnavailable extends Error {
  constructor(readonly cause_: unknown) {
    super(`gateway unreachable: ${String(cause_)}`)
    this.name = 'GatewayUnavailable'
  }
}

export interface GatewayResponse<T> {
  status: number
  body: T
}

export class GatewayClient {
  constructor(private readonly baseUrl: string) {}

  private async req<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GatewayResponse<T>> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      throw new GatewayUnavailable(e)
    }
    let parsed: unknown = null
    const text = await res.text()
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text }
      }
    }
    if (!res.ok) {
      const errBody = (parsed as { error?: { code?: string; message?: string; [k: string]: unknown } } | null)?.error
      throw new GatewayError(
        res.status,
        errBody?.code ?? `HTTP_${res.status}`,
        errBody?.message ?? `gateway ${res.status}`,
        errBody,
      )
    }
    return { status: res.status, body: parsed as T }
  }

  connect(accountId: string) {
    return this.req<{ platformUserId: string }>('POST', `/accounts/${accountId}/connect`)
  }

  disconnect(accountId: string) {
    return this.req('POST', `/accounts/${accountId}/disconnect`)
  }

  createGroup(creatorAccountId: string) {
    return this.req<{ groupId: string }>('POST', '/groups', { creatorAccountId })
  }

  invite(groupId: string) {
    return this.req<{ inviteLink: string; readyAfterMs: number }>('POST', `/groups/${groupId}/invite`)
  }

  join(groupId: string, accountId: string, inviteLink: string) {
    return this.req('POST', `/groups/${groupId}/join`, { accountId, inviteLink })
  }

  promote(groupId: string, byAccountId: string, accountId: string) {
    return this.req('POST', `/groups/${groupId}/promote`, { byAccountId, accountId })
  }

  kick(groupId: string, byAccountId: string, targetPlatformUserId: string) {
    return this.req<{ kicked: boolean }>('POST', `/groups/${groupId}/kick`, { byAccountId, targetPlatformUserId })
  }

  leave(groupId: string, accountId: string) {
    return this.req('POST', `/groups/${groupId}/leave`, { accountId })
  }

  members(groupId: string) {
    return this.req<string[]>('GET', `/groups/${groupId}/members`)
  }

  send(groupId: string, accountId: string, clientMsgId: string, text: string) {
    return this.req('POST', `/groups/${groupId}/send`, { accountId, clientMsgId, text })
  }

  messageByClientId(groupId: string, clientMsgId: string) {
    return this.req<{ msgId: string; sentAt: number }>(
      'GET',
      `/groups/${groupId}/messages/by-client-id/${encodeURIComponent(clientMsgId)}`,
    )
  }
}
