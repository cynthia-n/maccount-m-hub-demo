import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@mhub/shared'
import { requireAuth } from '../plugins/auth'

const idParam = z.string().uuid().or(z.string().min(1))

export function jobRoutes(app: FastifyInstance) {
  app.get('/api/jobs/:jobId', { preHandler: [requireAuth()] }, async (req) => {
    const jobId = idParam.parse((req.params as { jobId: string }).jobId)
    const { rows } = await app.db.query<{
      id: string
      status: string
      errors: Array<{ step: string; code: string }>
    }>('SELECT id, status, errors FROM jobs WHERE id=$1', [jobId])
    const job = rows[0]
    if (!job) throw new AppError(404, ErrorCode.JOB_NOT_FOUND, 'job 不存在')
    const { rows: steps } = await app.db.query<{ step: string; status: string; detail: unknown }>(
      'SELECT step, status, detail FROM job_steps WHERE job_id=$1',
      [jobId],
    )
    return {
      status: job.status,
      errors: job.errors ?? [],
      steps: steps.map((s) => ({ step: s.step, status: s.status, detail: s.detail })), // 额外字段：进度可见
    }
  })
}
