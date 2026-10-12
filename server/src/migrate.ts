import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './db'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export interface Migration {
  version: number
  name: string
  sql: string
}

export function listMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const m = /^(\d+)_(.+)\.sql$/.exec(file)
      if (!m) throw new Error(`迁移文件名不符合 <版本>_<名称>.sql：${file}`)
      return { version: Number(m[1]), name: m[2] ?? file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }
    })
}

export const EXPECTED_SCHEMA_VERSION = listMigrations().length

export async function runMigrations(db: Db): Promise<number[]> {
  const applied: number[] = []
  await db.withTx(async (q) => {
    // 并发迁移保护
    await q('SELECT pg_advisory_xact_lock(918273645)')
    await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    const { rows } = await q<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    const done = new Set(rows.map((r) => r.version))
    for (const m of listMigrations()) {
      if (done.has(m.version)) continue
      await q(m.sql)
      await q('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name])
      applied.push(m.version)
    }
  })
  return applied
}

export async function freshDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE')
  await db.query('CREATE SCHEMA public')
  await runMigrations(db)
}

// A0：schema 落后于代码时服务拒绝启动
export async function checkSchemaVersion(db: Db): Promise<void> {
  const { rows } = await db.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
  const current = rows[0]?.v ?? 0
  if (current !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本(${current}) 与代码期望(${EXPECTED_SCHEMA_VERSION}) 不一致：` +
        (current < EXPECTED_SCHEMA_VERSION ? '请先运行 npm run migrate' : '数据库比代码新，拒绝启动'),
    )
  }
}
