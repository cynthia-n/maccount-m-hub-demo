import { AppError, ErrorCode } from '@mhub/shared'
import type { Db } from '../db'
import type { GatewayClient, GatewayError as GwError } from '../gateway/client'
import { scheduleTaskIn } from '../workers/due-tasks'

// A3 建群 job：create → invite → join:<acc>… → promote，异步、可重启续跑。
// 等待点（invite not ready / join 等事件 / 网关退避）落 jobs.waiting_for，由 due_task 或
// member_joined 事件唤醒。单实例内用互斥集合防同 job 并发推进。

export interface CreateGroupParams {
  creatorAccountId: string
  memberAccountIds: string[]
}

const inFlight = new Set<string>()

/** 提交建群：校验 + 建 groups/jobs/job_steps 行（一个事务），返回 jobId */
export async function submitCreateGroup(db: Db, params: CreateGroupParams): Promise<string> {
  const { creatorAccountId, memberAccountIds } = params
  const ids = [creatorAccountId, ...memberAccountIds]
  const { rows } = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM accounts WHERE id = ANY($1)',
    [ids],
  )
  const byId = new Map(rows.map((r) => [r.id, r.status]))
  if (!byId.has(creatorAccountId)) throw new AppError(404, ErrorCode.ACCOUNT_NOT_FOUND, '创建者账号不存在')
  for (const id of ids) {
    if (byId.get(id) !== 'online') {
      throw new AppError(422, ErrorCode.ACCOUNT_NOT_ONLINE, `账号 ${id} 不在线`, { accountId: id })
    }
  }

  return db.withTx(async (q) => {
    const g = await q<{ id: string }>(
      'INSERT INTO groups (gateway_group_id, creator_account_id) VALUES (NULL, $1) RETURNING id',
      [creatorAccountId],
    )
    const groupId = g.rows[0]!.id
    const job = await q<{ id: string }>(
      `INSERT INTO jobs (type, group_id, params) VALUES ('create_group', $1, $2::jsonb) RETURNING id`,
      [groupId, JSON.stringify(params)],
    )
    const jobId = job.rows[0]!.id
    const steps = ['create', 'invite', ...memberAccountIds.map((a) => `join:${a}`), 'promote']
    for (const step of steps) {
      await q('INSERT INTO job_steps (job_id, step) VALUES ($1, $2)', [jobId, step])
    }
    return jobId
  })
}

function isGwUnavailable(e: unknown): boolean {
  return (e as { name?: string }).name === 'GatewayUnavailable' ||
    ((e as GwError).status !== undefined && (e as GwError).status >= 500)
}

function gwCode(e: unknown): string {
  return (e as GwError).code ?? 'GATEWAY_ERROR'
}

async function loadJob(db: Db, jobId: string) {
  const { rows } = await db.query<{
    id: string
    status: string
    group_id: string
    params: CreateGroupParams
    waiting_for: string | null
    errors: Array<{ step: string; code: string }>
  }>('SELECT id, status, group_id, params, waiting_for, errors FROM jobs WHERE id = $1', [jobId])
  return rows[0] ?? null
}

async function loadSteps(db: Db, jobId: string) {
  const { rows } = await db.query<{ step: string; status: string; detail: Record<string, unknown> }>(
    'SELECT step, status, detail FROM job_steps WHERE job_id = $1',
    [jobId],
  )
  return rows.sort((a, b) => stepRank(a.step) - stepRank(b.step))
  function stepRank(s: string): number {
    if (s === 'create') return 0
    if (s === 'invite') return 1
    if (s === 'promote') return 3
    return 2 // join:*（彼此顺序无关，全部完成才进 promote）
  }
}

async function setStepDone(db: Db, jobId: string, step: string, detail: Record<string, unknown>): Promise<void> {
  await db.query(`UPDATE job_steps SET status='done', detail = detail || $3::jsonb, updated_at=now()
                  WHERE job_id=$1 AND step=$2`, [jobId, step, JSON.stringify(detail)])
}

async function setStepDetail(db: Db, jobId: string, step: string, detail: Record<string, unknown>): Promise<void> {
  await db.query('UPDATE job_steps SET detail = detail || $3::jsonb, updated_at=now() WHERE job_id=$1 AND step=$2', [
    jobId,
    step,
    JSON.stringify(detail),
  ])
}

async function setWaiting(db: Db, jobId: string, waiting: string | null): Promise<void> {
  await db.query('UPDATE jobs SET waiting_for = $2, updated_at=now() WHERE id=$1', [jobId, waiting])
}

async function failJob(db: Db, jobId: string, step: string, code: string): Promise<void> {
  await db.query('UPDATE job_steps SET status=$3, updated_at=now() WHERE job_id=$1 AND step=$2', [jobId, step, 'failed'])
  await db.query(
    `UPDATE jobs SET status='failed', errors = errors || $2::jsonb, updated_at=now() WHERE id=$1`,
    [jobId, JSON.stringify([{ step, code }])],
  )
}

/** 推进 job 直到下一个等待点/完成/失败。可安全重复调用（互斥 + waiting 门控）。 */
export async function advanceJob(
  db: Db,
  jobId: string,
  gateway: GatewayClient,
  joinTimeoutMs = Number(process.env.JOIN_TIMEOUT_MS ?? 10_000),
): Promise<void> {
  if (inFlight.has(jobId)) return
  inFlight.add(jobId)
  try {
    await advanceLoop(db, jobId, gateway, joinTimeoutMs)
  } finally {
    inFlight.delete(jobId)
  }
}

async function advanceLoop(db: Db, jobId: string, gateway: GatewayClient, joinTimeoutMs: number): Promise<void> {
  for (;;) {
    const job = await loadJob(db, jobId)
    if (!job || job.status !== 'running' || job.waiting_for) return
    const steps = await loadSteps(db, jobId)
    const current = steps.find((s) => s.status !== 'done')
    if (!current) {
      await db.query("UPDATE jobs SET status='finished', updated_at=now() WHERE id=$1 AND status='running'", [jobId])
      return
    }
    const params = job.params
    const groupId = job.group_id

    try {
      if (current.step === 'create') {
        const r = await gateway.createGroup(params.creatorAccountId)
        const gatewayGroupId = r.body.groupId
        await db.withTx(async (q) => {
          await q('UPDATE groups SET gateway_group_id=$2 WHERE id=$1', [groupId, gatewayGroupId])
          const creator = await q<{ platform_user_id: string }>(
            'SELECT platform_user_id FROM accounts WHERE id=$1',
            [params.creatorAccountId],
          )
          await q(
            `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
             VALUES ($1, $2, $3, 'creator') ON CONFLICT (group_id, account_id) DO NOTHING`,
            [groupId, params.creatorAccountId, creator.rows[0]!.platform_user_id],
          )
        })
        await setStepDone(db, jobId, 'create', { gatewayGroupId })
        continue
      }

      if (current.step === 'invite') {
        const inviteAttempts = Number(current.detail.inviteAttempts ?? 0)
        const inv = await gateway.invite(String(await currentGroupId(db, groupId)))
        // 链接先落库并标 done（等待只是让时间过去，唤醒后不得重新 invite）
        await setStepDone(db, jobId, 'invite', { ...inv.body, inviteAttempts: inviteAttempts + 1 })
        if (inv.body.readyAfterMs > 0) {
          // B2：INVITE_NOT_READY 语义——等到 readyAfterMs 再继续
          await setWaiting(db, jobId, 'invite_ready')
          await db.withTx(async (q) => {
            await scheduleTaskIn(q, 'job_invite_ready', inv.body.readyAfterMs, { jobId })
          })
          return
        }
        continue
      }

      if (current.step.startsWith('join:')) {
        const accountId = current.step.slice(5)
        const inviteStep = steps.find((s) => s.step === 'invite')!
        const inviteLink = String(inviteStep.detail.inviteLink)
        const attempts = Number(current.detail.attempts ?? 0)
        try {
          await gateway.join(String(await currentGroupId(db, groupId)), accountId, inviteLink)
          // 202 受理：真正入群等 member_joined
          await setWaiting(db, jobId, current.step)
          await db.withTx(async (q) => {
            await scheduleTaskIn(q, 'job_join_timeout', joinTimeoutMs, { jobId, accountId })
          })
          await setStepDetail(db, jobId, current.step, { attempts: attempts + 1 })
          return
        } catch (e) {
          if (isGwUnavailable(e)) throw e
          const code = gwCode(e)
          if (code === 'ALREADY_MEMBER') {
            // 视为成功，直接进入后续（promote 会执行）
            await db.withTx(async (q) => {
              const pu = await q<{ platform_user_id: string }>(
                'SELECT platform_user_id FROM accounts WHERE id=$1',
                [accountId],
              )
              await q(
                `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
                 VALUES ($1, $2, $3, 'member') ON CONFLICT (group_id, account_id) DO NOTHING`,
                [groupId, accountId, pu.rows[0]!.platform_user_id],
              )
            })
            await setStepDone(db, jobId, current.step, { alreadyMember: true })
            continue
          }
          if (code === 'INVITE_EXPIRED') {
            // 重新申请链接再试一次
            if (attempts >= 2) {
              await failJob(db, jobId, current.step, 'INVITE_EXPIRED')
              return
            }
            const newInv = await gateway.invite(String(await currentGroupId(db, groupId)))
            await setStepDetail(db, jobId, 'invite', { ...newInv.body, inviteAttempts: attempts + 1 })
            await setStepDetail(db, jobId, current.step, { attempts: attempts + 1 })
            continue
          }
          await failJob(db, jobId, current.step, code)
          return
        }
      }

      if (current.step === 'promote') {
        const adminId = params.memberAccountIds[0]!
        const attempts = Number(current.detail.attempts ?? 0)
        try {
          await gateway.promote(String(await currentGroupId(db, groupId)), params.creatorAccountId, adminId)
          // 本地成员角色同步为 admin（member_joined 已写入 member）
          await db.query(`UPDATE group_members SET role='admin' WHERE group_id=$1 AND account_id=$2`, [groupId, adminId])
          await setStepDone(db, jobId, 'promote', { attempts: attempts + 1 })
          continue
        } catch (e) {
          if (isGwUnavailable(e)) throw e
          const code = gwCode(e)
          if (code === 'NOT_MEMBER_YET' && attempts < 1) {
            // promote 总调用数 ≤ 2：等一下再试一次
            await setWaiting(db, jobId, 'promote_retry')
            await setStepDetail(db, jobId, 'promote', { attempts: attempts + 1 })
            await db.withTx(async (q) => {
              await scheduleTaskIn(q, 'job_advance', 1500, { jobId, waiting: 'promote_retry' })
            })
            return
          }
          await failJob(db, jobId, 'promote', code)
          return
        }
      }
    } catch (e) {
      if (isGwUnavailable(e)) {
        // 网关不可用：退避后重试，job 保持 running
        const retries = Number(current.detail.retries ?? 0)
        if (retries >= 6) {
          await failJob(db, jobId, current.step, 'GATEWAY_UNAVAILABLE')
          return
        }
        await setStepDetail(db, jobId, current.step, { retries: retries + 1 })
        await setWaiting(db, jobId, 'retry')
        await db.withTx(async (q) => {
          await scheduleTaskIn(q, 'job_advance', 400 * 2 ** retries, { jobId, waiting: 'retry' })
        })
        return
      }
      throw e
    }
  }
}

async function currentGroupId(db: Db, groupId: string): Promise<string> {
  const { rows } = await db.query<{ gateway_group_id: string | null }>(
    'SELECT gateway_group_id FROM groups WHERE id=$1',
    [groupId],
  )
  const gw = rows[0]?.gateway_group_id
  if (!gw) throw new Error(`group ${groupId} 尚未在网关创建`)
  return gw
}

/** due_task：等待点唤醒 */
export async function resumeJob(
  db: Db,
  jobId: string,
  gateway: GatewayClient,
  expectedWaiting?: string,
): Promise<void> {
  const clause = expectedWaiting !== undefined
    ? await db.query('UPDATE jobs SET waiting_for=NULL, updated_at=now() WHERE id=$1 AND waiting_for=$2', [jobId, expectedWaiting])
    : await db.query('UPDATE jobs SET waiting_for=NULL, updated_at=now() WHERE id=$1', [jobId])
  if ((clause.rowCount ?? 0) > 0) {
    await advanceJob(db, jobId, gateway)
  }
}

/** inbox member_joined 唤醒：写成员表 + 唤醒对应 join 步 */
export async function notifyMemberJoined(
  db: Db,
  gatewayGroupId: string,
  platformUserId: string,
  gateway: GatewayClient,
): Promise<void> {
  const { rows: g } = await db.query<{ id: string }>('SELECT id FROM groups WHERE gateway_group_id=$1', [gatewayGroupId])
  if (!g[0]) return
  const { rows: a } = await db.query<{ id: string }>('SELECT id FROM accounts WHERE platform_user_id=$1', [platformUserId])
  if (!a[0]) return // 外部用户，不进我们的成员表
  const groupId = g[0].id
  const accountId = a[0].id

  await db.withTx(async (q) => {
    await q(
      `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
       VALUES ($1, $2, $3, 'member') ON CONFLICT (group_id, account_id) DO NOTHING`,
      [groupId, accountId, platformUserId],
    )
  })

  // 唤醒等待该账号的 join 步
  const waitingStep = `join:${accountId}`
  const { rows: jobs } = await db.query<{ id: string }>(
    `SELECT id FROM jobs WHERE status='running' AND waiting_for=$1 AND group_id=$2`,
    [waitingStep, groupId],
  )
  for (const j of jobs) {
    await db.query(`UPDATE job_steps SET status='done', detail = detail || $3::jsonb, updated_at=now()
                    WHERE job_id=$1 AND step=$2 AND status<>'done'`, [j.id, waitingStep, JSON.stringify({ joined: true })])
    await resumeJob(db, j.id, gateway, waitingStep)
  }
}

/** inbox member_left：按 platformUserId 删成员表 */
export async function notifyMemberLeft(db: Db, gatewayGroupId: string, platformUserId: string): Promise<void> {
  const { rows: g } = await db.query<{ id: string }>('SELECT id FROM groups WHERE gateway_group_id=$1', [gatewayGroupId])
  if (!g[0]) return
  await db.query(
    'DELETE FROM group_members WHERE group_id=$1 AND platform_user_id=$2',
    [g[0].id, platformUserId],
  )
}

/** due_task：join 超时——member_joined 超过时限未到 → job failed（JOIN_TIMEOUT） */
export async function handleJoinTimeout(db: Db, jobId: string, accountId: string): Promise<void> {
  const step = `join:${accountId}`
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM job_steps WHERE job_id=$1 AND step=$2',
    [jobId, step],
  )
  if (!rows[0] || rows[0].status === 'done') return // 已入群，超时任务作废
  await failJob(db, jobId, step, 'JOIN_TIMEOUT')
}

/** job 轮询器：捞起可推进的 running job */
export async function pollJobs(db: Db, gateway: GatewayClient, joinTimeoutMs?: number): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM jobs WHERE status='running' AND waiting_for IS NULL ORDER BY created_at LIMIT 5`,
  )
  for (const r of rows) {
    await advanceJob(db, r.id, gateway, joinTimeoutMs)
  }
}
