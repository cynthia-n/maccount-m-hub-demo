import type { FastifyInstance } from 'fastify'
import { AppError, ErrorCode } from '@mhub/shared'
import { requireAuth } from '../plugins/auth'
import { createSequence, sequenceDefSchema, sequenceRunBody, startSequenceRun } from '../domain/sequence'
import { submitLeaveAll } from '../domain/jobs'

export function sequenceRoutes(app: FastifyInstance) {
  app.post('/api/sequences', { preHandler: [requireAuth({ admin: true })] }, async (req) => {
    const def = sequenceDefSchema.parse(req.body)
    const id = await createSequence(app.db, def)
    return { id }
  })

  app.post('/api/groups/:id/sequence-runs', { preHandler: [requireAuth({ admin: true })] }, async (req, reply) => {
    const groupId = (req.params as { id: string }).id
    const body = sequenceRunBody.parse(req.body)
    const { rows: g } = await app.db.query<{ id: string }>('SELECT id FROM groups WHERE id=$1', [groupId])
    if (!g[0]) throw new AppError(404, ErrorCode.GROUP_NOT_FOUND, '群不存在')
    const { runId } = await startSequenceRun(app.db, groupId, body)
    return reply.status(201).send({ runId })
  })

  app.get('/api/sequence-runs/:id', { preHandler: [requireAuth()] }, async (req) => {
    const runId = (req.params as { id: string }).id
    const { rows } = await app.db.query<{
      id: string
      status: string
      current_step_index: number | null
    }>('SELECT id, status, current_step_index FROM sequence_runs WHERE id=$1', [runId])
    const run = rows[0]
    if (!run) throw new AppError(404, ErrorCode.SEQUENCE_RUN_NOT_FOUND, '序列运行不存在')
    const { rows: steps } = await app.db.query<{
      step_index: number
      status: string
      scheduled_at: Date | null
      sent_at: Date | null
      client_msg_id: string | null
      resolved_vars: Record<string, string>
      var_sources: Record<string, string>
    }>(
      `SELECT step_index, status, scheduled_at, sent_at, client_msg_id, resolved_vars, var_sources
       FROM sequence_steps WHERE run_id=$1 ORDER BY step_index`,
      [runId],
    )
    return {
      status: run.status,
      currentStepIndex: run.current_step_index,
      steps: steps.map((s) => ({
        index: s.step_index,
        status: s.status,
        scheduledAt: s.scheduled_at?.toISOString() ?? null,
        sentAt: s.sent_at?.toISOString() ?? null,
        clientMsgId: s.client_msg_id,
        resolvedVars: s.resolved_vars,
        varSources: s.var_sources,
      })),
    }
  })

  // B2 leave-all
  app.post('/api/groups/:id/leave-all', { preHandler: [requireAuth({ admin: true })] }, async (req, reply) => {
    const groupId = (req.params as { id: string }).id
    const jobId = await submitLeaveAll(app.db, groupId)
    return reply.status(202).send({ jobId })
  })
}
