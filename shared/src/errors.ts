// 统一错误：HTTP 层一律抛 AppError，由 server 的 setErrorHandler 序列化为
// { error: { code, message, requestId, ...extra } }

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function toErrorBody(e: AppError, requestId: string) {
  return {
    error: {
      code: e.code,
      message: e.message,
      requestId,
      ...(e.extra ?? {}),
    },
  }
}

// 题面与自设计错误码全集（新增里程碑按需引用；命名与题面逐字一致）
export const ErrorCode = {
  // 通用
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
  // 账号
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  CAS_CONFLICT: 'CAS_CONFLICT',
  ACCOUNT_UNAVAILABLE: 'ACCOUNT_UNAVAILABLE',
  ACCOUNT_NOT_IN_GROUP: 'ACCOUNT_NOT_IN_GROUP',
  // 群
  ACCOUNT_NOT_ONLINE: 'ACCOUNT_NOT_ONLINE',
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  // job / 序列
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  SEQUENCE_ALREADY_RUNNING: 'SEQUENCE_ALREADY_RUNNING',
  UNRESOLVED_PLACEHOLDER: 'UNRESOLVED_PLACEHOLDER',
  SEQUENCE_RUN_NOT_FOUND: 'SEQUENCE_RUN_NOT_FOUND',
  AGENT_RUN_NOT_FOUND: 'AGENT_RUN_NOT_FOUND',
  // 网关错误码（消息 failCode 用）
  RATE_LIMITED: 'RATE_LIMITED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  GROUP_WRITE_FORBIDDEN: 'GROUP_WRITE_FORBIDDEN',
  SENDER_NOT_IN_GROUP: 'SENDER_NOT_IN_GROUP',
  ACCOUNT_OFFLINE: 'ACCOUNT_OFFLINE',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  ACCOUNT_TERMINAL: 'ACCOUNT_TERMINAL',
  GROUP_UNREACHABLE: 'GROUP_UNREACHABLE',
  // job 步骤错误码
  JOIN_TIMEOUT: 'JOIN_TIMEOUT',
  LEAVE_FAILED: 'LEAVE_FAILED',
} as const
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]
