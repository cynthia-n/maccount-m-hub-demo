import fastify, { type FastifyInstance } from 'fastify'
import { createAgentState, nextResponse, consumeResend, type AgentMockState, type ScriptStep } from './state'

export interface AgentMock {
  app: FastifyInstance
  state: AgentMockState
}

const TOOL_NAMES = ['get_recent_messages', 'send_message', 'kick_user', 'finish']

export function buildAgentMock(): AgentMock {
  const state = createAgentState()
  const app = fastify({ logger: false })

  app.get('/api/health', async () => ({ ok: true, service: 'agent-mock' }))

  app.post('/agent/turn', async (req, reply) => {
    const body = req.body as {
      runId?: string
      tools?: Array<{ name: string; input_schema?: { required?: unknown } | null }>
      messages?: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; content?: string }> }>
    }
    // 题面：tools 必须恰好 4 个且 required 全覆盖，否则 400 TOOLS_INVALID
    const toolNames = (body.tools ?? []).map((t) => t.name)
    if (
      toolNames.length !== 4 ||
      !TOOL_NAMES.every((n) => toolNames.includes(n)) ||
      (body.tools ?? []).some(
        (t) =>
          typeof t.input_schema !== 'object' ||
          t.input_schema === null ||
          !Array.isArray((t.input_schema as { required?: unknown }).required) ||
          ((t.input_schema as { required: unknown[] }).required as unknown[]).length === 0,
      )
    ) {
      return reply.status(400).send({ error: { code: 'TOOLS_INVALID', message: 'tools must be exactly the 4 agreed tools with full required' } })
    }
    const runId = String(body.runId ?? 'run-unknown')

    // resend_same_key 语义：收到 send 的 tool_result 后，同 key 再调一次
    if (body.messages) {
      const lastMsg = body.messages[body.messages.length - 1]
      const toolResults = (lastMsg?.content ?? []).filter((c) => c.type === 'tool_result') as Array<{
        tool_use_id?: string
        content?: string
      }>
      if (consumeResend(state, runId, toolResults)) {
        const key = `k-resend-${runId.slice(0, 8)}`
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: `tu_r2_${runId.slice(0, 6)}`, name: 'send_message', input: { text: 'resend test', idempotency_key: key } }],
        }
      }
    }

    const resp = nextResponse(state, runId, { messages: body.messages ?? [] })
    if (resp.hang) {
      // 永不返回：挂起连接
      await new Promise(() => {})
    }
    if (resp.delayMs > 0) await new Promise((r) => setTimeout(r, resp.delayMs))
    if (resp.status !== 200) return reply.status(resp.status).send({ error: { code: 'MOCK', message: 'mock error' } })
    reply.type('application/json')
    return resp.body // 注意：可能是非 JSON 字符串（bad_json 场景）
  })

  app.post('/agent/audit', async (req, reply) => {
    state.auditCalls += 1
    const { mode, ms } = state.audit
    if (ms > 0) await new Promise((r) => setTimeout(r, ms))
    switch (mode) {
      case '500':
        return reply.status(500).send({ error: { code: 'AUDIT_INTERNAL', message: 'audit down' } })
      case 'badjson':
        reply.type('text/plain')
        return 'verdict: pass, trust me'
      case 'fail':
        return { verdict: 'fail', reason: 'mock 拒绝' }
      case 'slow':
        await new Promise((r) => setTimeout(r, 30_000))
        return { verdict: 'pass', reason: 'too late' }
      default:
        return { verdict: 'pass', reason: 'ok' }
    }
  })

  app.post('/__ctl', async (req) => {
    const { op, ...params } = (req.body ?? {}) as { op: string } & Record<string, unknown>
    switch (op) {
      case 'script':
        state.scripts.set(String(params.runId), (params.steps ?? []) as ScriptStep[])
        return { ok: true }
      case 'scriptAll':
        state.scripts.set('*', (params.steps ?? []) as ScriptStep[])
        return { ok: true }
      case 'setAudit':
        state.audit = {
          mode: (params.mode as AgentMockState['audit']['mode']) ?? 'ok',
          ms: typeof params.ms === 'number' ? params.ms : 0,
        }
        return { ok: true }
      default:
        return { ok: false, reason: `unknown op ${op}` }
    }
  })

  app.get('/__state', async () => ({
    turns: Object.fromEntries(state.turns),
    auditCalls: state.auditCalls,
    audit: state.audit,
  }))

  return { app, state }
}
