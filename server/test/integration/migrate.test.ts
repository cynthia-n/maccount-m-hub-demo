import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTest, teardownTest, type TestCtx } from '../helpers'

let ctx: TestCtx

beforeAll(async () => {
  ctx = await setupTest()
})
afterAll(async () => {
  await teardownTest(ctx)
})

describe('A0 迁移可重复执行', () => {
  it('重复执行 runMigrations 幂等', async () => {
    const { runMigrations } = await import('../../src/migrate')
    const applied = await runMigrations(ctx.db)
    expect(applied).toEqual([]) // setupTest 已全部应用，再次执行不应有任何动作
  })

  it('fresh 后表与索引齐全', async () => {
    const { rows } = await ctx.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
    )
    const tables = new Set(rows.map((r) => r.table_name))
    for (const t of [
      'users', 'auth_sessions', 'refresh_tokens', 'access_tokens',
      'accounts', 'groups', 'group_members',
      'agent_runs', 'agent_steps', 'agent_idempotency',
      'sequences', 'sequence_runs', 'sequence_steps',
      'messages', 'gateway_events', 'ws_outbox',
      'jobs', 'job_steps', 'due_tasks', 'meta', 'schema_migrations',
    ]) {
      expect(tables.has(t), `缺少表 ${t}`).toBe(true)
    }
  })

  it('部分唯一索引存在（每群至多一个 running 的 run / 序列）', async () => {
    const { rows } = await ctx.db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname IN ('agent_runs_one_running','sequence_runs_one_running')`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toContain("WHERE (status = 'running'::text)")
  })
})

describe('A0 schema 版本门禁', () => {
  it('版本一致时通过', async () => {
    const { checkSchemaVersion } = await import('../../src/migrate')
    await expect(checkSchemaVersion(ctx.db)).resolves.toBeUndefined()
  })

  it('schema 落后于代码时拒绝（模拟少应用一个迁移）', async () => {
    const { checkSchemaVersion, EXPECTED_SCHEMA_VERSION } = await import('../../src/migrate')
    await ctx.db.query('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)')
    await expect(checkSchemaVersion(ctx.db)).rejects.toThrow(/npm run migrate/)
    // 还原（本文件是最后执行的集成测试之一，还原避免影响其它用例的假设）
    await ctx.db.query(
      'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [EXPECTED_SCHEMA_VERSION, 'restored'],
    )
  })
})
