// Agent 模拟器内核（docs/API.md §3）：按 runId 消费脚本队列；无脚本时走默认链
export type ScriptStep =
  | { type: 'bad_json' }
  | { type: 'markdown' }
  | { type: 'unknown_tool' }
  | { type: 'bad_input' }
  | { type: 'dup_tool_use_id' }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'end_turn'; text?: string }
  | { type: 'slow'; ms: number; then?: ScriptStep }
  | { type: 'never' }
  | { type: 'resend_same_key'; text?: string }

export interface AuditKnob {
  mode: 'ok' | 'fail' | '500' | 'badjson' | 'slow'
  ms: number
}

export interface AgentMockState {
  scripts: Map<string, ScriptStep[]>
  auditCalls: number
  audit: AuditKnob
  turns: Map<string, number>
  lastToolUseId: Map<string, string>
  resendKeys: Map<string, string> // runId → 待重发的 idempotency_key
  seenToolResults: Map<string, Set<string>> // runId → 已处理过的 tool_use_id（检测重复 id）
}

export function createAgentState(): AgentMockState {
  return {
    scripts: new Map(),
    auditCalls: 0,
    audit: { mode: 'ok', ms: 0 },
    turns: new Map(),
    lastToolUseId: new Map(),
    resendKeys: new Map(),
    seenToolResults: new Map(),
  }
}

let tuSeq = 1

/** 弹出下一个响应（slow 的 then 延迟后返回其内容形状） */
export function nextResponse(
  state: AgentMockState,
  runId: string,
  request: { messages: unknown[] },
): { delayMs: number; status: number; body: string; hang?: boolean } {
  const count = (state.turns.get(runId) ?? 0) + 1
  state.turns.set(runId, count)
  const script = state.scripts.get(runId) ?? state.scripts.get('*')
  const step: ScriptStep | undefined = script?.shift()

  const mk = (obj: unknown): { delayMs: number; status: number; body: string } => ({
    delayMs: 0,
    status: 200,
    body: JSON.stringify(obj),
  })
  const toolUse = (name: string, input: Record<string, unknown>) => {
    const id = `tu_${tuSeq++}`
    state.lastToolUseId.set(runId, id)
    return mk({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] })
  }

  if (!step) {
    // 默认链：第 1 轮查消息，第 2 轮发言，之后结束
    if (count === 1) return toolUse('get_recent_messages', { limit: 10 })
    if (count === 2) return toolUse('send_message', { text: 'mock 回复', idempotency_key: `k-${runId.slice(0, 8)}-${count}` })
    return mk({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] })
  }

  switch (step.type) {
    case 'bad_json':
      return { delayMs: 0, status: 200, body: '抱歉，我无法完成。{"stop_reason": "end_turn"} 以上。' }
    case 'markdown':
      return {
        delayMs: 0,
        status: 200,
        body: '```json\n' + JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'wrapped' }] }) + '\n```',
      }
    case 'unknown_tool':
      return toolUse('self_destruct', {})
    case 'bad_input':
      return toolUse('get_recent_messages', { limit: 'ten' })
    case 'dup_tool_use_id': {
      const id = state.lastToolUseId.get(runId) ?? 'tu_dup'
      return mk({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'get_recent_messages', input: { limit: 5 } }] })
    }
    case 'tool':
      return toolUse(step.name, step.input)
    case 'end_turn':
      return mk({ stop_reason: 'end_turn', content: [{ type: 'text', text: step.text ?? 'done' }] })
    case 'slow': {
      if (step.then) script?.unshift(step.then)
      const inner = nextResponse(state, runId, request)
      return { delayMs: step.ms, status: inner.status, body: inner.body }
    }
    case 'never':
      return { delayMs: 0, status: 200, body: '', hang: true }
    case 'resend_same_key': {
      const key = `k-resend-${runId.slice(0, 8)}`
      state.resendKeys.set(runId, key)
      return toolUse('send_message', { text: step.text ?? 'resend test', idempotency_key: key })
    }
  }
}

/** resend_same_key 的第二段：收到 send 的 tool_result 后，用同一个 key 再调一次 */
export function consumeResend(state: AgentMockState, runId: string, toolResults: Array<{ tool_use_id?: string; content?: string }>): boolean {
  const key = state.resendKeys.get(runId)
  if (!key) return false
  const hasSendResult = toolResults.some((tr) => typeof tr.content === 'string' && tr.content.includes('clientMsgId'))
  if (!hasSendResult) return false
  state.resendKeys.delete(runId)
  return true
}
