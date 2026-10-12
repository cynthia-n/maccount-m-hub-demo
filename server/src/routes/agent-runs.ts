import type { FastifyInstance } from 'fastify'
import { AppError, ErrorCode } from '@mhub/shared'
import { requireAuth } from '../plugins/auth'

// A5.12：每一步（含协议错误步）都可查
export function agentRunRoutes(app: FastifyInstance) {
  app.get('/api/agent-runs/:id', { preHandler: [requireAuth()] }, async (req) => {
    const id = (req.params as { id: string }).id
    const { rows } = await app.db.query<{
      id: string
      group_id: string
      status: string
      end_reason: string | null
      summary: string | null
    }>('SELECT id, group_id, status, end_reason, summary FROM agent_runs WHERE id=$1', [id])
    const run = rows[0]
    if (!run) throw new AppError(404, ErrorCode.AGENT_RUN_NOT_FOUND, 'agent run 不存在')
    const { rows: steps } = await app.db.query<{
      idx: number
      kind: string
      tool_use_id: string | null
      name: string | null
      input: unknown
      result_summary: string | null
      is_error: boolean
      error_code: string | null
      audit_verdict: string | null
      raw_response: string | null
    }>(
      `SELECT idx, kind, tool_use_id, name, input, result_summary, is_error, error_code, audit_verdict, raw_response
       FROM agent_steps WHERE run_id=$1 ORDER BY idx`,
      [id],
    )
    return {
      id: run.id,
      groupId: run.group_id,
      status: run.status,
      endReason: run.end_reason,
      summary: run.summary,
      steps: steps.map((s) => ({
        kind: s.kind,
        toolUseId: s.tool_use_id,
        name: s.name,
        input: s.input,
        resultSummary: s.result_summary,
        isError: s.is_error,
        errorCode: s.error_code,
        auditVerdict: s.audit_verdict,
        rawResponse: s.raw_response,
      })),
    }
  })

  app.get('/api/groups/:id/agent-runs', { preHandler: [requireAuth()] }, async (req) => {
    const groupId = (req.params as { id: string }).id
    const { rows } = await app.db.query<{
      id: string
      group_id: string
      status: string
      end_reason: string | null
      summary: string | null
    }>(
      `SELECT id, group_id, status, end_reason, summary FROM agent_runs WHERE group_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [groupId],
    )
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      status: r.status,
      endReason: r.end_reason,
      summary: r.summary,
    }))
  })
}
