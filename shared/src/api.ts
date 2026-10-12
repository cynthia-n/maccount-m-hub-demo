// API 契约类型（docs/API.md 的镜像）。前端与 server 共用，字段名与题面逐字一致。
import type { AccountStatus } from './state-machine'

export interface HealthResponse {
  ok: boolean
  schemaVersion: number
}

export interface LoginRequest {
  username: string
  password: string
}
export interface LoginResponse {
  accessToken: string
  role?: 'admin' | 'viewer'
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    requestId: string
    [key: string]: unknown
  }
}

// —— 账号 ——
export type AccountRole = 'creator' | 'admin' | 'member'

export interface AccountDto {
  id: string
  status: AccountStatus
  platformUserId: string | null
  rateLimitedUntil: string | null
}

// —— 群 ——
export interface GroupMemberDto {
  accountId: string
  platformUserId: string | null
  role: AccountRole
}

export interface GroupDto {
  id: string
  gatewayGroupId: string | null
  status: 'active' | 'unreachable' | 'left'
  creatorAccountId: string
  agentEnabled: boolean
  autoKickEnabled: boolean
  members: GroupMemberDto[]
  activeSequenceRunId: string | null
  activeAgentRunId: string | null
}

// —— 消息 ——
export type DeliveryStatus =
  | 'queued'
  | 'accepted'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'cancelled'

export interface MessageDto {
  msgId: string | null
  clientMsgId: string | null
  senderPlatformUserId: string | null
  isOwn: boolean
  text: string
  sentAt: string
  deliveryStatus: DeliveryStatus | null
  failCode: string | null
}

// —— WS ——
export type WsEventType =
  | 'account_status_changed'
  | 'account_terminal'
  | 'inconsistency'
  | 'message'
  | 'agent_run'
  | 'sequence_run'

export interface WsEventFrame {
  seq: number
  type: WsEventType
  payload: Record<string, unknown>
}
