import { randomUUID } from 'node:crypto'
import type { Config } from '../config'
import type { Db } from '../db'
import type { GatewayClient } from '../gateway/client'
import { enqueueOutbound, isGwUnavailable } from './outbound'
import { emitWs } from '../ws/outbox'
import { scheduleTaskIn } from '../workers/due-tasks'
import type { AgentClient } from '../agent/client'

// A5 Agent 接入：触发（每群单 run，部分唯一索引兜底）→ 循环（12 步/60s/3 连协议错误）
// → 协议错误两类处理 → 审计 → 幂等键 → 每步落库可恢复（P1/P2/P3 三个持久化点）。

export const AGENT_TOOLS = [
  {
    name: 'get_recent_messages',
    description: '读取群内最近消息（按时间升序，包含触发消息与 run 期间新到的消息）',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } }, required: ['limit'] },
  },
  {
    name: 'send_message',
    description: '以群内服务账号身份发送一条消息',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, idempotency_key: { type: 'string' } },
      required: ['text', 'idempotency_key'],
    },
  },
  {
    name: 'kick_user',
    description: '将成员移出群（需要群开启 autoKick 且由管理员角色执行）',
    input_schema: {
      type: 'object',
      properties: { platform_user_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['platform_user_id', 'reason'],
    },
  },
  {
    name: 'finish',
    description: '结束本次运行并给出总结',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
] as const

const activeLoops = new Set<string>()

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n)
}

export interface RunRow {
  id: string
  group_id: string
  status: string
  end_reason: string | null
  summary: string | null
  trigger: {
    groupId?: string
    triggerMessages?: Array<{ msgId: string; senderPlatformUserId: string; text: string; sentAt: string }>
    policy?: { autoKickEnabled?: boolean }
    ownPlatformUserIds?: string[]
  }
  history: Array<Record<string, unknown>>
  step_count: number
  consecutive_protocol_errors: number
  deadline_at: Date
  pending_action: PendingAction | null
  pending_message_ids: string[]
}

interface PendingAction {
  toolUseId: string
  name: 'send_message' | 'kick_user'
  input: Record<string, unknown>
  idempotencyKey?: string
  messageId?: string
  kick?: { byAccountId: string; targetPlatformUserId: string }
  phase: 'audit_passed' | 'executing'
}

async function loadRun(db: Db, runId: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>('SELECT * FROM agent_runs WHERE id=$1', [runId])
  const r = rows[0]
  if (!r) return null
  return {
    ...r,
    trigger: (r.trigger ?? {}) as RunRow['trigger'],
    history: (r.history ?? []) as RunRow['history'],
    pending_message_ids: (r.pending_message_ids ?? []) as string[],
  }
}

async function emitRunEvent(q: Parameters<typeof emitWs>[0], run: { id: string; group_id: string; status: string; end_reason: string | null }): Promise<void> {
  await emitWs(q, 'agent_run', { runId: run.id, groupId: run.group_id, status: run.status, endReason: run.end_reason })
}

/** 触发：非自己消息进入 agentEnabled 群 → 建 run；已有 running run 则挂到 pending_message_ids */
export async function agentTrigger(db: Db, ourGroupId: string, messageId: string): Promise<void> {
  const { rows: g } = await db.query<{ agent_enabled: boolean; gateway_group_id: string | null; auto_kick_enabled: boolean; creator_account_id: string }>(
    'SELECT agent_enabled, gateway_group_id, auto_kick_enabled, creator_account_id FROM groups WHERE id=$1',
    [ourGroupId],
  )
  const group = g[0]
  if (!group?.agent_enabled || !group.gateway_group_id) return

  const { rows: msg } = await db.query<{ msg_id: string; sender_platform_user_id: string; text: string; sent_at: Date }>(
    'SELECT msg_id, sender_platform_user_id, text, sent_at FROM messages WHERE id=$1',
    [messageId],
  )
  const m = msg[0]
  if (!m) return

  const { rows: own } = await db.query<{ platform_user_id: string }>(
    'SELECT platform_user_id FROM accounts WHERE platform_user_id IS NOT NULL',
  )
  const trigger = {
    groupId: group.gateway_group_id,
    triggerMessages: [
      { msgId: m.msg_id, senderPlatformUserId: m.sender_platform_user_id, text: m.text, sentAt: m.sent_at.toISOString() },
    ],
    policy: { autoKickEnabled: group.auto_kick_enabled },
    ownPlatformUserIds: own.map((o) => o.platform_user_id),
  }

  try {
    await db.withTx(async (q) => {
      const runId = randomUUID()
      await q(
        `INSERT INTO agent_runs (id, group_id, status, trigger, deadline_at)
         VALUES ($1, $2, 'running', $3::jsonb, now() + make_interval(secs => $4))`,
        [runId, ourGroupId, JSON.stringify(trigger), 60],
      )
      await emitRunEvent(q, { id: runId, group_id: ourGroupId, status: 'running', end_reason: null })
      await scheduleTaskIn(q, 'agent_deadline', 60_000, { runId })
    })
  } catch (e) {
    // 每群至多一个 running：挂到现有 run 的待处理队列（链式下一次 run）
    if ((e as { code?: string }).code !== '23505') throw e
    await db.query(
      `UPDATE agent_runs SET pending_message_ids = pending_message_ids || to_jsonb($2::text), updated_at=now()
       WHERE group_id=$1 AND status='running'`,
      [ourGroupId, messageId],
    )
  }
}

interface ToolResult {
  content: Record<string, unknown>
  isError: boolean
  errorCode?: string
  auditVerdict?: string
  /** blocked：run 应转为 blocked 并终止循环 */
  blocked?: boolean
  /** finish：run 应转为 finished(final) */
  finished?: boolean
  summary?: string
}

/** worker 轮询器：为所有未激活的 running run 启动循环（也覆盖重启恢复） */
export async function pollAgentRuns(db: Db, agent: AgentClient, gateway: GatewayClient, cfg: Config): Promise<void> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM agent_runs WHERE status='running' ORDER BY created_at`)
  for (const r of rows) {
    if (!activeLoops.has(r.id)) {
      void runAgentLoop(db, agent, gateway, r.id, cfg).catch((e) => {
        console.error(`[agent-loop ${r.id}]`, e)
      })
    }
  }
}

export async function runAgentLoop(
  db: Db,
  agent: AgentClient,
  gateway: GatewayClient,
  runId: string,
  cfg: Config,
): Promise<void> {
  if (activeLoops.has(runId)) return
  activeLoops.add(runId)
  try {
    for (;;) {
      const run = await loadRun(db, runId)
      if (!run || run.status !== 'running') return

      // 预算与外部状态检查（A5.2/A5.10）
      if (new Date(run.deadline_at).getTime() <= Date.now()) {
        await finishRun(db, runId, 'failed', 'wall_clock', run)
        return
      }
      const { rows: g } = await db.query<{ agent_enabled: boolean; status: string }>(
        'SELECT agent_enabled, status FROM groups WHERE id=$1',
        [run.group_id],
      )
      if (!g[0] || !g[0].agent_enabled || g[0].status !== 'active') {
        await finishRun(db, runId, 'cancelled', 'cancelled', run)
        return
      }
      if (run.step_count >= cfg.AGENT_MAX_STEPS) {
        await finishRun(db, runId, 'failed', 'budget_exhausted', run)
        return
      }

      // 崩溃恢复锚点：上一步工具已审计未完成 → 先收尾再继续
      if (run.pending_action) {
        const result = await reconcilePending(db, gateway, run, cfg)
        if (result.blocked) {
          await blockRun(db, runId)
          return
        }
        await commitToolResult(db, runId, run.step_count + 1, result, run.pending_action.toolUseId)
        if (result.finished) {
          await finishRun(db, runId, 'finished', 'final', await loadRun(db, runId), result.summary)
          return
        }
        continue
      }

      // 组装并调用 /agent/turn（超时竞速；迟响应随 abort 丢弃）
      const messages = [
        { role: 'user', content: [{ type: 'text', text: JSON.stringify(run.trigger) }] },
        ...run.history,
      ]
      const outcome = await agent.turn(runId, AGENT_TOOLS, messages, cfg.TURN_TIMEOUT_MS)
      const raw = 'raw' in outcome ? trunc(outcome.raw ?? '', 2048) : ''

      if (!outcome.ok && outcome.reason === 'timeout') {
        await recordProtocolError(db, runId, run, 'TURN_TIMEOUT', 'agent 服务响应超时', '')
        if (await maybeFailProtocolErrors(db, runId)) return
        continue
      }
      if (!outcome.ok) {
        await recordProtocolError(db, runId, run, 'BAD_JSON', `agent 服务返回 ${outcome.reason}${'status' in outcome && outcome.status ? ` ${outcome.status}` : ''}`, raw)
        if (await maybeFailProtocolErrors(db, runId)) return
        continue
      }

      // 校验响应形状（2.2：合法响应每轮恰好一个块，stop_reason 与块类型一致）
      const parsed = validateTurnResponse(outcome.raw)
      if (!parsed) {
        await recordProtocolError(db, runId, run, 'BAD_JSON', '响应不是合法 JSON 或形状不符', raw)
        if (await maybeFailProtocolErrors(db, runId)) return
        continue
      }
      await db.query('UPDATE agent_runs SET consecutive_protocol_errors = 0, updated_at=now() WHERE id=$1', [runId])

      if (parsed.stop === 'end_turn') {
        await commitStep(db, runId, run.step_count, {
          kind: 'final',
          resultSummary: trunc(parsed.text ?? '', 200),
          rawResponse: raw,
        })
        await appendHistory(db, runId, { role: 'assistant', content: [{ type: 'text', text: parsed.text ?? '' }] })
        await finishRun(db, runId, 'finished', 'final', await loadRun(db, runId), parsed.text ?? '')
        return
      }

      // tool_use
      const { id, name, input } = parsed.tool
      const { rows: dup } = await db.query<{ 1: number }>(
        `SELECT 1 FROM agent_steps WHERE run_id=$1 AND tool_use_id=$2 AND kind='tool_use'`,
        [runId, id],
      )
      if (dup[0]) {
        await recordProtocolError(db, runId, run, 'DUPLICATE_TOOL_USE_ID', `tool_use.id ${id} 重复`, raw)
        if (await maybeFailProtocolErrors(db, runId)) return
        continue
      }

      // P1：assistant 块 + 步记录先落库（占位，不 bump；工具完成后由 commitToolResult 计步）
      await appendHistory(db, runId, { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
      await commitStep(db, runId, run.step_count, { kind: 'tool_use', toolUseId: id, name, input, rawResponse: raw }, false)

      const result = await executeTool(db, agent, gateway, runId, { id, name, input }, cfg)
      if (result.blocked) {
        await blockRun(db, runId)
        return
      }
      await commitToolResult(db, runId, run.step_count + 1, result, id)
      // A5.3：未知工具/入参不合 schema 也算协议错误（合法响应已清零，这里重新累计）
      if (result.errorCode === 'UNKNOWN_TOOL' || result.errorCode === 'INVALID_INPUT') {
        await db.query('UPDATE agent_runs SET consecutive_protocol_errors = consecutive_protocol_errors + 1 WHERE id=$1', [runId])
        if (await maybeFailProtocolErrors(db, runId)) return
      }

      if (result.finished) {
        await finishRun(db, runId, 'finished', 'final', await loadRun(db, runId), result.summary)
        return
      }
      // 回到循环顶部：重新读 run（step_count 已 +1）
    }
  } finally {
    activeLoops.delete(runId)
  }
}

function validateTurnResponse(raw: string): { stop: 'end_turn'; text: string } | { stop: 'tool_use'; tool: { id: string; name: string; input: Record<string, unknown> } } | null {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  const b = body as { stop_reason?: unknown; content?: unknown }
  if (typeof b.stop_reason !== 'string' || !Array.isArray(b.content) || b.content.length !== 1) return null
  const block = b.content[0] as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown }
  if (b.stop_reason === 'end_turn' && block.type === 'text' && typeof block.text === 'string') {
    return { stop: 'end_turn', text: block.text }
  }
  if (
    b.stop_reason === 'tool_use' &&
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string' &&
    typeof block.input === 'object' && block.input !== null
  ) {
    return { stop: 'tool_use', tool: { id: block.id, name: block.name, input: block.input as Record<string, unknown> } }
  }
  return null
}

async function appendHistory(db: Db, runId: string, entry: Record<string, unknown>): Promise<void> {
  await db.query('UPDATE agent_runs SET history = history || $2::jsonb, updated_at=now() WHERE id=$1', [
    runId,
    JSON.stringify(entry),
  ])
}

interface StepRecord {
  kind: 'tool_use' | 'final' | 'protocol_error'
  toolUseId?: string
  name?: string
  input?: Record<string, unknown>
  resultSummary?: string
  isError?: boolean
  errorCode?: string
  auditVerdict?: string
  rawResponse?: string
}

async function commitStep(db: Db, runId: string, idx: number, rec: StepRecord, bump = true): Promise<void> {
  await db.query(
    `INSERT INTO agent_steps (run_id, idx, kind, tool_use_id, name, input, result_summary, is_error, error_code, audit_verdict, raw_response)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
     ON CONFLICT (run_id, idx) DO UPDATE SET
       result_summary=EXCLUDED.result_summary, is_error=EXCLUDED.is_error, error_code=EXCLUDED.error_code,
       audit_verdict=EXCLUDED.audit_verdict, raw_response=EXCLUDED.raw_response`,
    [
      runId,
      idx,
      rec.kind,
      rec.toolUseId ?? null,
      rec.name ?? null,
      rec.input ? JSON.stringify(rec.input) : null,
      rec.resultSummary ?? null,
      rec.isError ?? false,
      rec.errorCode ?? null,
      rec.auditVerdict ?? null,
      rec.rawResponse ?? null,
    ],
  )
  if (bump) {
    await db.query('UPDATE agent_runs SET step_count = $2, updated_at=now() WHERE id=$1', [runId, idx + 1])
  }
}

/** P1 的 tool_use 步先以占位写入（step_count+1 由 commitToolResult 完成） */
async function recordProtocolError(db: Db, runId: string, run: RunRow, code: string, message: string, raw: string): Promise<void> {
  await db.withTx(async (q) => {
    await q(
      `INSERT INTO agent_steps (run_id, idx, kind, result_summary, is_error, error_code, raw_response)
       VALUES ($1, $2, 'protocol_error', $3, true, $4, $5)
       ON CONFLICT (run_id, idx) DO NOTHING`,
      [runId, run.step_count, trunc(`PROTOCOL_ERROR ${code}: ${message}`, 200), code, trunc(raw, 2048)],
    )
    await q(
      `UPDATE agent_runs SET step_count=$2, consecutive_protocol_errors = consecutive_protocol_errors + 1,
         history = history || $3::jsonb, updated_at=now() WHERE id=$1`,
      [runId, run.step_count + 1, JSON.stringify({ role: 'user', content: [{ type: 'text', text: `PROTOCOL_ERROR ${code}: ${message}` }] })],
    )
  })
}

async function maybeFailProtocolErrors(db: Db, runId: string): Promise<boolean> {
  const { rows } = await db.query<{ consecutive_protocol_errors: number }>(
    'SELECT consecutive_protocol_errors FROM agent_runs WHERE id=$1',
    [runId],
  )
  if ((rows[0]?.consecutive_protocol_errors ?? 0) >= 3) {
    const run = await loadRun(db, runId)
    if (run) await finishRun(db, runId, 'failed', 'protocol_errors', run)
    return true
  }
  return false
}

async function commitToolResult(db: Db, runId: string, idx: number, result: ToolResult, toolUseId: string): Promise<void> {
  // 单个 tool_result content ≤ 8KB（A5.9）；截断后必须是合法 JSON（C2 的真实 LLM 要解析它）
  let content = JSON.stringify(result.content)
  if (content.length > 8192) {
    content = JSON.stringify({
      truncated: true,
      partial: JSON.stringify(result.content).slice(0, 7500),
      hint: 'original tool result exceeded 8KB and was truncated',
    })
  }
  await db.withTx(async (q) => {
    await q(
      `UPDATE agent_steps SET result_summary=$3, is_error=$4, error_code=$5, audit_verdict=$6
       WHERE run_id=$1 AND idx=$2`,
      [runId, idx - 1 < 0 ? 0 : idx - 1, trunc(JSON.stringify(result.content), 200), result.isError, result.errorCode ?? null, result.auditVerdict ?? null],
    )
    await q(
      `UPDATE agent_runs SET history = history || $2::jsonb, pending_action=NULL,
         step_count = GREATEST(step_count, $3), updated_at=now() WHERE id=$1`,
      [runId, JSON.stringify({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, ...(result.isError ? { is_error: true } : {}), content }] }), idx],
    )
  })
}

async function finishRun(
  db: Db,
  runId: string,
  status: 'finished' | 'failed' | 'blocked' | 'cancelled',
  endReason: string,
  run?: RunRow | null,
  summary?: string,
): Promise<void> {
  await db.withTx(async (q) => {
    const r = await q(
      `UPDATE agent_runs SET status=$2, end_reason=$3, summary=COALESCE($4, summary), updated_at=now()
       WHERE id=$1 AND status='running' RETURNING group_id`,
      [runId, status, endReason, summary ?? null],
    )
    if ((r.rowCount ?? 0) === 0) return
    await emitRunEvent(q, { id: runId, group_id: (r.rows[0] as { group_id: string }).group_id, status, end_reason: endReason })

    // 链式下一次 run：待处理消息全部放进 triggerMessages（与结束同事务，防丢触发）
    const runRow = run ?? (await loadRun(db, runId))
    const pending = runRow?.pending_message_ids ?? []
    if (pending.length > 0 && r.rows[0]) {
      const groupId = (r.rows[0] as { group_id: string }).group_id
      const { rows: msgs } = await q<{ msg_id: string; sender_platform_user_id: string; text: string; sent_at: Date }>(
        'SELECT msg_id, sender_platform_user_id, text, sent_at FROM messages WHERE id = ANY($1) ORDER BY sent_at',
        [pending],
      )
      const { rows: own } = await q<{ platform_user_id: string }>('SELECT platform_user_id FROM accounts WHERE platform_user_id IS NOT NULL')
      const { rows: grp } = await q<{ gateway_group_id: string | null; auto_kick_enabled: boolean }>(
        'SELECT gateway_group_id, auto_kick_enabled FROM groups WHERE id=$1',
        [groupId],
      )
      const trigger = {
        groupId: grp[0]?.gateway_group_id,
        triggerMessages: msgs.map((m) => ({ msgId: m.msg_id, senderPlatformUserId: m.sender_platform_user_id, text: m.text, sentAt: m.sent_at.toISOString() })),
        policy: { autoKickEnabled: grp[0]?.auto_kick_enabled ?? false },
        ownPlatformUserIds: own.map((o) => o.platform_user_id),
      }
      await q(
        `INSERT INTO agent_runs (id, group_id, status, trigger, deadline_at)
         VALUES ($1, $2, 'running', $3::jsonb, now() + make_interval(secs => $4))
         ON CONFLICT (group_id) WHERE status = 'running' DO NOTHING`,
        [randomUUID(), groupId, JSON.stringify(trigger), 60],
      )
    }
  })
}

async function blockRun(db: Db, runId: string): Promise<void> {
  await finishRun(db, runId, 'blocked', 'audit_blocked')
}

// ── 工具执行 ──────────────────────────────────────────────────

async function executeTool(
  db: Db,
  agent: AgentClient,
  gateway: GatewayClient,
  runId: string,
  tool: { id: string; name: string; input: Record<string, unknown> },
  cfg: Config,
): Promise<ToolResult> {
  const run = await loadRun(db, runId)
  if (!run) return { content: { ok: false }, isError: true, errorCode: 'INVALID_INPUT' }
  const groupId = run.group_id

  if (tool.name === 'get_recent_messages') {
    const limit = Math.min(50, Math.max(1, Number(tool.input.limit) || 10))
    const { rows } = await db.query<{ msg_id: string; sender_platform_user_id: string; is_own: boolean; text: string; sent_at: Date }>(
      `SELECT msg_id, sender_platform_user_id, is_own, text, sent_at FROM messages
       WHERE group_id=$1 AND msg_id IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT $2`,
      [groupId, limit],
    )
    const messages = rows.reverse().map((m) => ({
      msgId: m.msg_id,
      senderPlatformUserId: m.sender_platform_user_id,
      isOwn: m.is_own,
      text: m.text.length > 500 ? m.text.slice(0, 500) : m.text,
      sentAt: m.sent_at.toISOString(),
      ...(m.text.length > 500 ? { truncatedText: true } : {}),
    }))
    const truncated = rows.some((m) => m.text.length > 500)
    const content: Record<string, unknown> = { messages, truncated }

    // D-01：连续相同入参的 get_recent_messages → 附提示引导收尾
    const { rows: prev } = await db.query<{ input: Record<string, unknown> }>(
      `SELECT input FROM agent_steps WHERE run_id=$1 AND name='get_recent_messages' AND kind='tool_use' AND idx < $2 ORDER BY idx DESC LIMIT 1`,
      [runId, run.step_count],
    )
    if (prev[0] && JSON.stringify(prev[0].input) === JSON.stringify(tool.input)) {
      content.hint = 'repeated identical request; wrap up with finish or send_message'
    }
    return { content, isError: false }
  }

  if (tool.name === 'finish') {
    const summary = typeof tool.input.summary === 'string' ? tool.input.summary : ''
    return { content: { ok: true }, isError: false, finished: true, summary }
  }

  if (tool.name === 'send_message') {
    const text = tool.input.text
    const key = tool.input.idempotency_key
    if (typeof text !== 'string' || !text || typeof key !== 'string' || !key) {
      return { content: { code: 'INVALID_INPUT', message: 'text 与 idempotency_key 必填' }, isError: true, errorCode: 'INVALID_INPUT' }
    }
    // A5.7 幂等：同 key 第二次起不发不审，返回该消息当前状态
    const { rows: reg } = await db.query<{ message_id: string }>(
      'SELECT message_id FROM agent_idempotency WHERE run_id=$1 AND idempotency_key=$2',
      [runId, key],
    )
    if (reg[0]) {
      return await waitForSendResolution(db, reg[0].message_id, key, cfg.AGENT_SEND_WAIT_MS)
    }

    // 审计（≤3 次；失败不回给 agent、不计步）
    const audit = await runAuditWithRetry(agent, text, groupId, cfg)
    if (audit.blocked) return { content: { code: 'AUDIT_BLOCKED' }, isError: true, errorCode: 'AUDIT_BLOCKED', blocked: true }
    if (audit.verdict === 'fail') {
      return { content: { code: 'AUDIT_REJECTED', message: audit.reason }, isError: true, errorCode: 'AUDIT_REJECTED', auditVerdict: 'fail' }
    }

    // 选执行账号（D-05：member > admin > creator）
    const account = await pickAccount(db, groupId, ['member', 'admin', 'creator'])
    if (!account) {
      return { content: { code: 'NO_AVAILABLE_ACCOUNT', message: '群内无可用在线账号' }, isError: true, errorCode: 'NO_AVAILABLE_ACCOUNT' }
    }

    // P2：注册幂等键 + 意图落库
    let messageId = ''
    await db.withTx(async (q) => {
      const clientMsgId = `cm-${randomUUID()}`
      const ins = await q<{ id: string }>(
        `INSERT INTO messages (group_id, direction, sender_account_id, is_own, text, sent_at, delivery_status, client_msg_id, agent_run_id, idempotency_key)
         VALUES ($1,'outbound',$2,true,$3,now(),'queued',$4,$5,$6) RETURNING id`,
        [groupId, account, text, clientMsgId, runId, key],
      )
      messageId = ins.rows[0]!.id
      await q('INSERT INTO agent_idempotency (run_id, idempotency_key, message_id) VALUES ($1,$2,$3)', [runId, key, messageId])
      await q(
        `UPDATE agent_runs SET pending_action=$2::jsonb, updated_at=now() WHERE id=$1`,
        [runId, JSON.stringify({ toolUseId: tool.id, name: 'send_message', input: tool.input, idempotencyKey: key, messageId, phase: 'executing' })],
      )
    })
    const res = await waitForSendResolution(db, messageId, key, cfg.AGENT_SEND_WAIT_MS)
    return { ...res, auditVerdict: 'pass' }
  }

  if (tool.name === 'kick_user') {
    const target = tool.input.platform_user_id
    const reason = tool.input.reason
    if (typeof target !== 'string' || !target || typeof reason !== 'string') {
      return { content: { code: 'INVALID_INPUT', message: 'platform_user_id 与 reason 必填' }, isError: true, errorCode: 'INVALID_INPUT' }
    }
    // A5.6 策略开关
    const { rows: grp } = await db.query<{ auto_kick_enabled: boolean; gateway_group_id: string | null }>(
      'SELECT auto_kick_enabled, gateway_group_id FROM groups WHERE id=$1',
      [groupId],
    )
    if (!grp[0]?.auto_kick_enabled) {
      return { content: { code: 'POLICY_DENIED', message: '该群未开启 autoKick' }, isError: true, errorCode: 'POLICY_DENIED' }
    }
    const auditText = JSON.stringify({ action: 'kick', platform_user_id: target, reason })
    const audit = await runAuditWithRetry(agent, auditText, groupId, cfg)
    if (audit.blocked) return { content: { code: 'AUDIT_BLOCKED' }, isError: true, errorCode: 'AUDIT_BLOCKED', blocked: true }
    if (audit.verdict === 'fail') {
      return { content: { code: 'AUDIT_REJECTED', message: audit.reason }, isError: true, errorCode: 'AUDIT_REJECTED', auditVerdict: 'fail' }
    }
    const account = await pickAccount(db, groupId, ['admin', 'creator'])
    if (!account) {
      return { content: { code: 'NO_AVAILABLE_ACCOUNT', message: '无 creator/admin 在线账号' }, isError: true, errorCode: 'NO_AVAILABLE_ACCOUNT' }
    }

    await db.query('UPDATE agent_runs SET pending_action=$2::jsonb, updated_at=now() WHERE id=$1', [
      runId,
      JSON.stringify({ toolUseId: tool.id, name: 'kick_user', input: tool.input, kick: { byAccountId: account, targetPlatformUserId: target }, phase: 'executing' }),
    ])
    const res = await doKick(db, gateway, groupId, account, target)
    return { ...res, auditVerdict: 'pass' }
  }

  return { content: { code: 'UNKNOWN_TOOL', message: `未知工具 ${tool.name}` }, isError: true, errorCode: 'UNKNOWN_TOOL' }
}

type AuditOutcome = { blocked: false; verdict: 'pass' | 'fail'; reason?: string } | { blocked: true }

async function runAuditWithRetry(agent: AgentClient, text: string, groupId: string, cfg: Config): Promise<AuditOutcome> {
  for (let attempt = 1; attempt <= cfg.AUDIT_ATTEMPTS; attempt++) {
    const r = await agent.audit(text, groupId, cfg.AUDIT_TIMEOUT_MS)
    if (r.ok && r.verdict === 'pass') return { blocked: false, verdict: 'pass' }
    if (r.ok && r.verdict === 'fail') return { blocked: false, verdict: 'fail', reason: r.reason }
    // 拿不到明确结论：重试（不计步、不返回给 agent）
  }
  return { blocked: true }
}

async function pickAccount(db: Db, groupId: string, roleOrder: Array<'member' | 'admin' | 'creator'>): Promise<string | null> {
  for (const role of roleOrder) {
    const { rows } = await db.query<{ account_id: string }>(
      `SELECT gm.account_id FROM group_members gm JOIN accounts a ON a.id = gm.account_id
       WHERE gm.group_id=$1 AND gm.role=$2 AND a.status='online' ORDER BY gm.account_id LIMIT 1`,
      [groupId, role],
    )
    if (rows[0]) return rows[0].account_id
  }
  return null
}

async function waitForSendResolution(db: Db, messageId: string, key: string, waitMs: number): Promise<ToolResult> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const { rows } = await db.query<{ delivery_status: string; fail_code: string | null; client_msg_id: string }>(
      'SELECT delivery_status, fail_code, client_msg_id FROM messages WHERE id=$1',
      [messageId],
    )
    const st = rows[0]?.delivery_status
    if (st === 'sent' || st === 'accepted') {
      return { content: { clientMsgId: rows[0]!.client_msg_id, deliveryStatus: st }, isError: false }
    }
    if (st === 'failed') {
      if (rows[0]!.fail_code === 'GROUP_UNREACHABLE') {
        return { content: { code: 'GROUP_UNREACHABLE', message: '群不可写' }, isError: true, errorCode: 'GROUP_UNREACHABLE' }
      }
      return { content: { code: 'SEND_FAILED', message: `发送失败: ${rows[0]!.fail_code}` }, isError: true, errorCode: 'SEND_FAILED' }
    }
    if (st === 'cancelled') {
      // 排队中被终态/群不可写取消（A5.5：账号中途变终态 → SEND_FAILED，run 继续）
      return { content: { code: 'SEND_FAILED', message: `发送被取消: ${rows[0]!.fail_code}` }, isError: true, errorCode: 'SEND_FAILED' }
    }
    if (Date.now() > deadline) {
      // 5 秒仍无法确认 → SEND_TIMEOUT（消息可能仍在管线中；幂等键已注册，重复调用会查到它）
      return { content: { code: 'SEND_TIMEOUT', message: '无法在时限内确认发送状态' }, isError: true, errorCode: 'SEND_TIMEOUT' }
    }
    await new Promise((r) => setTimeout(r, 120))
  }
}

async function doKick(db: Db, gateway: GatewayClient, groupId: string, byAccountId: string, target: string): Promise<ToolResult> {
  const { rows: g } = await db.query<{ gateway_group_id: string | null }>('SELECT gateway_group_id FROM groups WHERE id=$1', [groupId])
  const gwGroupId = g[0]?.gateway_group_id
  if (!gwGroupId) return { content: { code: 'GROUP_UNREACHABLE', message: '群未在网关创建' }, isError: true, errorCode: 'GROUP_UNREACHABLE' }
  try {
    await gateway.kick(gwGroupId, byAccountId, target)
    return { content: { kicked: true }, isError: false }
  } catch (e) {
    if (isGwUnavailable(e)) {
      // 结果未知：≤5s 内用成员列表收敛（网关保证 2 秒内收敛）
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300))
        try {
          const members = (await gateway.members(gwGroupId)).body
          if (!members.includes(target)) return { content: { kicked: true }, isError: false }
        } catch { /* 继续探 */ }
      }
      return { content: { code: 'KICK_UNRESOLVED', message: 'kick 结果未知' }, isError: true, errorCode: 'KICK_UNRESOLVED' }
    }
    const code = (e as { code?: string }).code ?? 'KICK_FAILED'
    return { content: { code, message: 'kick 被拒绝' }, isError: true, errorCode: code }
  }
}

/** 崩溃恢复：pending_action 收尾（send 查管线结果；kick 查成员列表）——已产生的外部效果不重放、不记失败 */
async function reconcilePending(db: Db, gateway: GatewayClient, run: RunRow, cfg: Config): Promise<ToolResult> {
  const pa = run.pending_action!
  if (pa.name === 'send_message') {
    let messageId = pa.messageId
    if (!messageId && pa.idempotencyKey) {
      const { rows } = await db.query<{ id: string }>(
        'SELECT m.id FROM messages m JOIN agent_idempotency i ON i.message_id=m.id WHERE i.run_id=$1 AND i.idempotency_key=$2',
        [run.id, pa.idempotencyKey],
      )
      messageId = rows[0]?.id
    }
    if (messageId) return await waitForSendResolution(db, messageId, pa.idempotencyKey ?? '', cfg.AGENT_SEND_WAIT_MS)
    // 审计已通过但尚未入队（理论不可达：注册与入队同事务）；兜底重新执行
  }
  if (pa.name === 'kick_user' && pa.kick) {
    return await doKick(db, gateway, run.group_id, pa.kick.byAccountId, pa.kick.targetPlatformUserId)
  }
  return { content: { code: 'INVALID_INPUT' }, isError: true, errorCode: 'INVALID_INPUT' }
}
