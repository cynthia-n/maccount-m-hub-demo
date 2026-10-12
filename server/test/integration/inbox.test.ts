import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GatewayEventHandler } from '../../src/workers/inbox'
import { defaultHandlers, processPendingInbox } from '../../src/workers/inbox'
import { startWorkers } from '../../src/workers/runner'
import { startSseClient, loadCursor } from '../../src/gateway/sse-client'
import { pollUntil, setupTest, startGatewayMock, teardownTest, type MockCtx, type TestCtx } from '../helpers'

let ctx: TestCtx
let mock: MockCtx
let sse: { stop: () => Promise<void> } | null = null
let workers: { stop: () => Promise<void> } | null = null

beforeAll(async () => {
  ctx = await setupTest()
  mock = await startGatewayMock()
  // 我们管理群 g-1；alpha 是我们账号（platform_user_id 与 mock 一致）
  await ctx.db.query(
    `INSERT INTO groups (gateway_group_id, creator_account_id) VALUES ('g-1', 'acc-alpha')`,
  )
  await ctx.db.query(
    `UPDATE accounts SET platform_user_id = 'pu-acc-alpha' WHERE id = 'acc-alpha'`,
  )
  // 测试内跑真实 inbox worker（50ms tick）
  workers = startWorkers(50, [
    { name: 'inbox', run: () => processPendingInbox(ctx.db, defaultHandlers()) },
  ])
})

afterAll(async () => {
  await sse?.stop()
  await workers?.stop()
  await mock.close()
  await teardownTest(ctx)
})

async function startSse(): Promise<{ stop: () => Promise<void> }> {
  return startSseClient({ db: ctx.db, gatewayUrl: mock.url })
}

describe('M1 inbox 管线', () => {
  it('SSE 连接后事件幂等入库并被处理（重复推送 → 时间线无重复行）', async () => {
    sse = await startSse()
    await mock.ctl('setDuplicateEvents', { n: 2 }) // S2：每个事件推两份
    await mock.ctl('emit', {
      type: 'message',
      data: { groupId: 'g-1', msgId: 'm-1', senderPlatformUserId: 'pu-acc-bravo', text: 'hi', sentAt: Date.now() },
    })

    await pollUntil(async () => {
      const { rows } = await ctx.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM gateway_events WHERE processed_at IS NOT NULL`,
      )
      return rows[0] && rows[0].n >= 2 ? rows[0].n : null
    })

    const { rows: msgRows } = await ctx.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM messages WHERE msg_id = 'm-1'`,
    )
    expect(msgRows[0]!.n).toBe(1) // 时间线无重复行

    const { rows: evRows } = await ctx.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gateway_events`,
    )
    expect(evRows[0]!.n).toBe(2) // 两份都入库（不同 eventId）

    await mock.ctl('setDuplicateEvents', { n: 1 }) // 复位，避免影响后续用例
  })

  it('自己的账号回流标 isOwn（S3 前置）', async () => {
    await mock.ctl('emit', {
      type: 'message',
      data: { groupId: 'g-1', msgId: 'm-2', senderPlatformUserId: 'pu-acc-alpha', text: 'self echo', sentAt: Date.now() },
    })
    await pollUntil(async () => {
      const { rows } = await ctx.db.query<{ is_own: boolean }>(`SELECT is_own FROM messages WHERE msg_id = 'm-2'`)
      return rows[0] ?? null
    })
    const { rows } = await ctx.db.query<{ is_own: boolean; sender_account_id: string | null }>(
      `SELECT is_own, sender_account_id FROM messages WHERE msg_id = 'm-2'`,
    )
    expect(rows[0]!.is_own).toBe(true)
    expect(rows[0]!.sender_account_id).toBe('acc-alpha')
  })

  it('停机补拉：断开期间的事件重连后全部入库', async () => {
    await sse!.stop()
    const before = (await mock.stateDump<{ maxEventId: number }>()).maxEventId
    await mock.ctl('emit', {
      type: 'message',
      data: { groupId: 'g-1', msgId: 'm-3', senderPlatformUserId: 'pu-acc-bravo', text: 'while down', sentAt: Date.now() },
    })
    expect((await mock.stateDump<{ maxEventId: number }>()).maxEventId).toBe(before + 1)

    sse = await startSse()
    await pollUntil(async () => {
      const { rows } = await ctx.db.query(`SELECT 1 FROM messages WHERE msg_id = 'm-3'`)
      return rows[0] ?? null
    })
    // 游标已推进
    await pollUntil(async () => {
      const cursor = await loadCursor(ctx.db)
      return cursor >= before + 1 ? cursor : null
    })
  })

  it('非我们管理的群事件被跳过（标记已处理）', async () => {
    await mock.ctl('emit', {
      type: 'message',
      data: { groupId: 'g-999', msgId: 'mx-1', senderPlatformUserId: 'pu-acc-bravo', text: 'foreign', sentAt: Date.now() },
    })
    await pollUntil(async () => {
      const { rows } = await ctx.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM gateway_events WHERE last_error IS NULL AND processed_at IS NOT NULL`,
      )
      return rows[0]!.n
    })
    const { rows } = await ctx.db.query(`SELECT 1 FROM messages WHERE msg_id = 'mx-1'`)
    expect(rows.length).toBe(0)
  })

  it('乱序窗口不影响按 eventId 顺序处理', async () => {
    await mock.ctl('setReorderWindowMs', { ms: 150 })
    for (const i of [1, 2, 3]) {
      await mock.ctl('emit', {
        type: 'message',
        data: { groupId: 'g-1', msgId: `mo-${i}`, senderPlatformUserId: 'pu-acc-bravo', text: `o${i}`, sentAt: Date.now() },
      })
    }
    await pollUntil(async () => {
      const { rows } = await ctx.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM messages WHERE msg_id LIKE 'mo-%'`,
      )
      return rows[0] && rows[0].n === 3 ? rows[0].n : null
    })
    await mock.ctl('setReorderWindowMs', { ms: 0 })
  })
})

describe('M1 inbox 失败隔离（A2：不中断、不丢失、推 inconsistency）', () => {
  it('handler 抛错不阻塞后续事件；连续 3 次失败推 inconsistency', async () => {
    // 直接插一条会失败的事件 + 一条正常事件
    await ctx.db.query(
      `INSERT INTO gateway_events (event_id, type, payload) VALUES (900001, 'boom', '{}'), (900002, 'boom_ok', '{"ok":1}')`,
    )
    const handlers: Record<string, GatewayEventHandler> = {
      ...defaultHandlers(),
      boom: async () => {
        throw new Error('boom!')
      },
      boom_ok: async (db) => {
        await db.query('SELECT 1')
      },
    }
    // 第一轮：boom 失败(attempts=1)，boom_ok 成功
    const r1 = await processPendingInbox(ctx.db, handlers)
    expect(r1.failed).toBe(1)
    expect(r1.processed).toBeGreaterThanOrEqual(1)

    const { rows: after1 } = await ctx.db.query<{ attempts: number; processed_at: Date | null }>(
      `SELECT attempts, processed_at FROM gateway_events WHERE event_id = 900001`,
    )
    expect(after1[0]!.attempts).toBe(1)
    expect(after1[0]!.processed_at).toBeNull()

    // 事件 900002 未被 boom 阻塞
    const { rows: okRow } = await ctx.db.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM gateway_events WHERE event_id = 900002`,
    )
    expect(okRow[0]!.processed_at).not.toBeNull()

    // 再处理两轮后：attempts=3 → inconsistency 出现在 ws_outbox，事件仍在（不丢失）
    await processPendingInbox(ctx.db, handlers)
    await processPendingInbox(ctx.db, handlers)
    const { rows: finalRow } = await ctx.db.query<{ attempts: number }>(
      `SELECT attempts FROM gateway_events WHERE event_id = 900001`,
    )
    expect(finalRow[0]!.attempts).toBeGreaterThanOrEqual(3)
    const { rows: inconsistency } = await ctx.db.query<{ type: string }>(
      `SELECT type FROM ws_outbox WHERE type = 'inconsistency'`,
    )
    expect(inconsistency.length).toBeGreaterThanOrEqual(1)
  })
})
