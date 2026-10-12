import { loadConfig } from './config'
import { createDb } from './db'
import { checkSchemaVersion } from './migrate'
import { ensureSeed } from './seed'
import { buildApp } from './app'
import { startRuntime } from './runtime'

async function main() {
  const cfg = loadConfig()
  const db = createDb(cfg.DATABASE_URL)

  // A0：schema 落后于代码时拒绝启动
  await checkSchemaVersion(db)
  await ensureSeed(db)

  const app = await buildApp(cfg, db, { logger: true })
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' })

  const runtime = startRuntime(app)

  const shutdown = async () => {
    await runtime.stop()
    await app.close()
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[server] 启动失败:', err instanceof Error ? err.message : err)
  process.exit(1)
})
