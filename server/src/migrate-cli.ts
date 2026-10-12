// 迁移 CLI：tsx src/migrate.ts up | fresh | check
import { loadConfig } from './config'
import { createDb } from './db'
import { EXPECTED_SCHEMA_VERSION, checkSchemaVersion, freshDatabase, runMigrations } from './migrate'

const cmd = process.argv[2] ?? 'up'
const cfg = loadConfig()
const db = createDb(cfg.DATABASE_URL)

try {
  if (cmd === 'up') {
    const applied = await runMigrations(db)
    console.log(applied.length ? `已应用迁移: ${applied.join(', ')}` : '无待应用迁移')
  } else if (cmd === 'fresh') {
    await freshDatabase(db)
    console.log(`已重建 schema 并应用全部迁移（期望版本 ${EXPECTED_SCHEMA_VERSION}）`)
  } else if (cmd === 'check') {
    await checkSchemaVersion(db)
    console.log(`schema 版本一致（${EXPECTED_SCHEMA_VERSION}）`)
  } else {
    throw new Error(`未知命令: ${cmd}（可用: up | fresh | check）`)
  }
  process.exit(0)
} catch (err) {
  console.error('[migrate] 失败:', err instanceof Error ? err.message : err)
  process.exit(1)
}
