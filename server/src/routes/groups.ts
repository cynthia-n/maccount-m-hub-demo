import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, ErrorCode, type AccountStatus } from '@mhub/shared'
import { requireAuth } from '../plugins/auth'
import { submitCreateGroup } from '../domain/jobs'
import { enqueueOutbound } from '../domain/outbound'

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

  // ── A2/A4：以服务账号身份发消息 + 消息时间线 ──────────────────
  const sendBody = z.object({ accountId: z.string().min(1), text: z.string().min(1) })
  const UNAVAILABLE: ReadonlySet<string> = new Set(['idle', 'disconnected', 'suspended', 'session_expired'])

  app.post('/api/groups/:id/send', { preHandler: [requireAuth({ admin: true })] }, async (req, reply) => {
    const groupId = (req.params as { id: string }).id
    const body = sendBody.parse(req.body)

    const { rows: g } = await app.db.query<{ id: string; status: string }>('SELECT id, status FROM groups WHERE id=$1', [groupId])
    if (!g[0]) throw new AppError(404, ErrorCode.GROUP_NOT_FOUND, '群不存在')
    if (g[0].status !== 'active') throw new AppError(409, ErrorCode.GROUP_UNREACHABLE, '群当前不可写')

    const { rows: a } = await app.db.query<{ status: AccountStatus }>('SELECT status FROM accounts WHERE id=$1', [body.accountId])
    if (!a[0]) throw new AppError(404, ErrorCode.ACCOUNT_NOT_FOUND, '账号不存在')
    if (UNAVAILABLE.has(a[0].status)) throw new AppError(409, ErrorCode.ACCOUNT_UNAVAILABLE, '账号当前不可用')

    const { rows: member } = await app.db.query(
      'SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2',
      [groupId, body.accountId],
    )
    if (!member[0]) throw new AppError(409, ErrorCode.ACCOUNT_NOT_IN_GROUP, '账号不在该群')

    // rate_limited 照常受理、保持 queued，到期按序发出
    const clientMsgId = await enqueueOutbound(app.db, { groupId, accountId: body.accountId, text: body.text })
    return reply.status(202).send({ clientMsgId })
  })

  app.get('/api/groups/:id/messages', { preHandler: [requireAuth()] }, async (req) => {
    const groupId = (req.params as { id: string }).id
    const query = z
      .object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {})
    const { rows: g } = await app.db.query<{ id: string }>('SELECT id FROM groups WHERE id=$1', [groupId])
    if (!g[0]) throw new AppError(404, ErrorCode.GROUP_NOT_FOUND, '群不存在')

    // keyset 分页：游标 = sentAt|id（同毫秒多条用 id 决胜，A4）
    let cursorSentAt: Date | null = null
    let cursorId: string | null = null
    if (query.before) {
      const [ts, idPart] = query.before.split('|')
      const t = new Date(ts ?? '')
      if (Number.isNaN(t.getTime()) || !idPart) throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'cursor 不合法')
      cursorSentAt = t
      cursorId = idPart
    }

    const { rows } = await app.db.query<{
      id: string
      msg_id: string | null
      client_msg_id: string | null
      sender_platform_user_id: string | null
      is_own: boolean
      text: string
      sent_at: Date
      delivery_status: string | null
      fail_code: string | null
    }>(
      `SELECT id, msg_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status, fail_code
         FROM messages
        WHERE group_id=$1
          AND ($2::timestamptz IS NULL OR (sent_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY sent_at DESC, id DESC
        LIMIT $4`,
      [groupId, cursorSentAt, cursorId, query.limit + 1],
    )
    const hasMore = rows.length > query.limit
    const page = rows.slice(0, query.limit)
    const last = page[page.length - 1]
    return {
      items: page.map((r) => ({
        msgId: r.msg_id,
        clientMsgId: r.client_msg_id,
        senderPlatformUserId: r.sender_platform_user_id,
        isOwn: r.is_own,
        text: r.text,
        sentAt: r.sent_at.toISOString(),
        deliveryStatus: r.delivery_status,
        failCode: r.fail_code,
      })),
      nextCursor: hasMore && last ? `${last.sent_at.toISOString()}|${last.id}` : null,
    }
  })
}
