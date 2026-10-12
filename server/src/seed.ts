import type { Db } from './db'
import { hashPassword } from './passwords'

// 启动/测试构建时幂等执行：预置用户与账号（题面：账号由 migration/seed 预置）
export async function ensureSeed(db: Db): Promise<void> {
  await db.withTx(async (q) => {
    await q(
      `INSERT INTO users (username, password_hash, role) VALUES
       ('admin', $1, 'admin'),
       ('viewer', $2, 'viewer')
       ON CONFLICT (username) DO NOTHING`,
      [hashPassword('admin'), hashPassword('viewer')],
    )
    for (const id of ['acc-alpha', 'acc-bravo', 'acc-charlie', 'acc-delta']) {
      await q(
        `INSERT INTO accounts (id, status) VALUES ($1, 'idle')
         ON CONFLICT (id) DO NOTHING`,
        [id],
      )
    }
  })
}
