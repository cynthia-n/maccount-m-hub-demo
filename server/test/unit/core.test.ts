import { describe, expect, it } from 'vitest'
import { AppError, toErrorBody, canTransition, transitionsFrom, isTerminal } from '@mhub/shared'

describe('错误体格式（A0）', () => {
  it('AppError 序列化为 { error: { code, message, requestId, ...extra } }', () => {
    const e = new AppError(409, 'ILLEGAL_TRANSITION', '不允许的转移', { from: 'idle', to: 'idle' })
    const body = toErrorBody(e, 'req-1')
    expect(body).toEqual({
      error: { code: 'ILLEGAL_TRANSITION', message: '不允许的转移', requestId: 'req-1', from: 'idle', to: 'idle' },
    })
  })

  it('无 extra 时不产生多余字段', () => {
    const body = toErrorBody(new AppError(401, 'UNAUTHORIZED', 'x'), 'r')
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId'])
  })
})

describe('A1 状态转移表（36 格逐格校验）', () => {
  const statuses = ['idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired'] as const
  const allowedMatrix: Record<(typeof statuses)[number], string[]> = {
    idle: ['online', 'suspended', 'session_expired'],
    online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
    rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
    disconnected: ['idle', 'online', 'suspended', 'session_expired'],
    suspended: [],
    session_expired: [],
  }

  for (const from of statuses) {
    for (const to of statuses) {
      it(`${from} → ${to}`, () => {
        expect(canTransition(from, to)).toBe(allowedMatrix[from].includes(to))
      })
    }
  }

  it('终态无出边', () => {
    expect(transitionsFrom('suspended')).toEqual([])
    expect(transitionsFrom('session_expired')).toEqual([])
    expect(isTerminal('suspended')).toBe(true)
    expect(isTerminal('idle')).toBe(false)
  })
})
