import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode } from '@mhub/shared'
import { requireAuth } from '../plugins/auth'
import { submitCreateGroup } from '../domain/jobs'

const createGroupBody = z.object({
  creatorAccountId: z.string().min(1),
  memberAccountIds: z.array(z.string().min(1)).min(1),
})

export function groupRoutes(app: FastifyInstance) {
  app.post('/api/groups', { preHandler: [requireAuth({ admin: true })] }, async (req, reply) => {
    const body = createGroupBody.parse(req.body)
    if (new Set(body.memberAccountIds).size !== body.memberAccountIds.length) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'memberAccountIds 有重复')
    }
    if (body.memberAccountIds.includes(body.creatorAccountId)) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'memberAccountIds 不能包含群主')
    }
    const jobId = await submitCreateGroup(app.db, body)
    return reply.status(202).send({ jobId })
  })

  const groupDto = (g: {
    id: string
    gateway_group_id: string | null
    status: string
    creator_account_id: string
    agent_enabled: boolean
    auto_kick_enabled: boolean
  }, members: Array<{ account_id: string; platform_user_id: string | null; role: string }>,
    activeSequenceRunId: string | null,
    activeAgentRunId: string | null,
  ) => ({
    id: g.id,
    gatewayGroupId: g.gateway_group_id,
    status: g.status,
    creatorAccountId: g.creator_account_id,
    agentEnabled: g.agent_enabled,
    autoKickEnabled: g.auto_kick_enabled,
    members: members.map((m) => ({ accountId: m.account_id, platformUserId: m.platform_user_id, role: m.role })),
    activeSequenceRunId,
    activeAgentRunId,
  })

  app.get('/api/groups', { preHandler: [requireAuth()] }, async () => {
    const { rows } = await app.db.query<{
      id: string
      gateway_group_id: string | null
      status: string
      creator_account_id: string
      agent_enabled: boolean
      auto_kick_enabled: boolean
    }>('SELECT * FROM groups ORDER BY created_at DESC')
    const out = []
    for (const g of rows) {
      const { rows: members } = await app.db.query<{
        account_id: string
        platform_user_id: string | null
        role: string
      }>(
        'SELECT account_id, platform_user_id, role FROM group_members WHERE group_id=$1 ORDER BY account_id',
        [g.id],
      )
      const { rows: seq } = await app.db.query<{ id: string }>(
        `SELECT id FROM sequence_runs WHERE group_id=$1 AND status='running'`,
        [g.id],
      )
      const { rows: agent } = await app.db.query<{ id: string }>(
        `SELECT id FROM agent_runs WHERE group_id=$1 AND status='running'`,
        [g.id],
      )
      out.push(groupDto(g, members, seq[0]?.id ?? null, agent[0]?.id ?? null))
    }
    return out
  })

  app.get('/api/groups/:id', { preHandler: [requireAuth()] }, async (req) => {
    const id = (req.params as { id: string }).id
    const { rows } = await app.db.query('SELECT * FROM groups WHERE id=$1', [id])
    const g = rows[0]
    if (!g) throw new AppError(404, ErrorCode.GROUP_NOT_FOUND, '群不存在')
    const { rows: members } = await app.db.query<{
      account_id: string
      platform_user_id: string | null
      role: string
    }>(
      'SELECT account_id, platform_user_id, role FROM group_members WHERE group_id=$1 ORDER BY account_id',
      [id],
    )
    const { rows: seq } = await app.db.query<{ id: string }>(
      `SELECT id FROM sequence_runs WHERE group_id=$1 AND status='running'`,
      [id],
    )
    const { rows: agent } = await app.db.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE group_id=$1 AND status='running'`,
      [id],
    )
    return groupDto(
      g as {
        id: string
        gateway_group_id: string | null
        status: string
        creator_account_id: string
        agent_enabled: boolean
        auto_kick_enabled: boolean
      },
      members,
      seq[0]?.id ?? null,
      agent[0]?.id ?? null,
    )
  })

  app.patch('/api/groups/:id', { preHandler: [requireAuth({ admin: true })] }, async (req) => {
    const id = (req.params as { id: string }).id
    const body = z
      .object({ agentEnabled: z.boolean().optional(), autoKickEnabled: z.boolean().optional() })
      .parse(req.body)
    const { rows } = await app.db.query<{ id: string }>('SELECT id FROM groups WHERE id=$1', [id])
    if (!rows[0]) throw new AppError(404, ErrorCode.GROUP_NOT_FOUND, '群不存在')
    await app.db.query(
      `UPDATE groups SET
         agent_enabled = COALESCE($2, agent_enabled),
         auto_kick_enabled = COALESCE($3, auto_kick_enabled)
       WHERE id=$1`,
      [id, body.agentEnabled ?? null, body.autoKickEnabled ?? null],
    )
    return { ok: true }
  })
}
