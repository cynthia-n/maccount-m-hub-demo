import type { Db } from '../db'
import type { WsHub } from '../ws/server'

// ws_outbox 广播器：轮询新行按 seq 推给已认证客户端。
// 轮询而非 LISTEN/NOTIFY：重启无状态恢复简单，250ms 延迟对演示足够。
export function createWsNotifier(db: Db, hub: WsHub) {
  let lastSeq = 0
  let initialized = false

  return async (): Promise<void> => {
    if (!initialized) {
      const { rows } = await db.query<{ max: string | null }>('SELECT MAX(seq) AS max FROM ws_outbox')
      lastSeq = rows[0]?.max ? Number(rows[0].max) : 0
      initialized = true
      return
    }
    const { rows } = await db.query<{ seq: string; type: string; payload: unknown }>(
      'SELECT seq, type, payload FROM ws_outbox WHERE seq > $1 ORDER BY seq LIMIT 200',
      [lastSeq],
    )
    for (const row of rows) {
      hub.broadcast({ seq: Number(row.seq), type: row.type, payload: row.payload })
      lastSeq = Number(row.seq)
    }
  }
}
