// SSE 客户端：拉网关事件流 → 幂等落 inbox 表 → 推进游标。
// 断线自动重连（带 since 补拉），停机期间的事件由游标保证补齐。
import type { Db, QueryFn } from '../db'

const CURSOR_KEY = 'sse_cursor'

export interface SseClient {
  stop: () => Promise<void>
}

export async function loadCursor(db: Db): Promise<number> {
  const { rows } = await db.query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [CURSOR_KEY])
  return rows[0] ? Number(rows[0].value) : 0
}

async function saveCursor(q: QueryFn, eventId: number): Promise<void> {
  await q(
    `INSERT INTO meta (key, value) VALUES ('sse_cursor', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE meta.value::bigint < $1::bigint`,
    [String(eventId)],
  )
}

export interface Frame {
  eventId: number
  type: string
  data: Record<string, unknown>
}

export function parseSseBuffer(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const part of parts) {
    let id = 0
    let event = 'message'
    let data = ''
    for (const line of part.split('\n')) {
      if (line.startsWith(':')) continue // 注释/心跳
      if (line.startsWith('id:')) id = Number(line.slice(3).trim())
      else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (id > 0 && data) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        frames.push({ eventId: id, type: event, data: parsed })
      } catch {
        // 非 JSON data 跳过（网关不会发，防御性）
      }
    }
  }
  return { frames, rest }
}

export function startSseClient(opts: {
  db: Db
  gatewayUrl: string
  log?: (msg: string) => void
  pollMs?: number
}): SseClient {
  const { db, gatewayUrl, log = () => {} } = opts
  let stopped = false
  let controller: AbortController | null = null

  async function ingest(frames: Frame[]): Promise<void> {
    if (frames.length === 0) return
    await db.withTx(async (q) => {
      for (const f of frames) {
        await q(
          `INSERT INTO gateway_events (event_id, type, payload)
           VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING`,
          [f.eventId, f.type, JSON.stringify(f.data)],
        )
      }
      await saveCursor(q, frames[frames.length - 1]!.eventId)
    })
  }

  async function runLoop(): Promise<void> {
    let backoff = 200
    while (!stopped) {
      controller = new AbortController()
      try {
        const cursor = await loadCursor(db)
        const res = await fetch(`${gatewayUrl}/events?since=${cursor}`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        backoff = 200
        log(`sse connected since=${cursor}`)

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const { frames, rest } = parseSseBuffer(buffer)
          buffer = rest
          // 每个数据块即时入库（一帧都不滞留）；mock 15s 心跳兜底保活
          await ingest(frames)
        }
      } catch (e) {
        if (stopped) break
        log(`sse error: ${e instanceof Error ? e.message : e}`)
      } finally {
        controller?.abort()
        controller = null
      }
      if (!stopped) {
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 5000)
      }
    }
  }

  const loop = runLoop()

  return {
    stop: async () => {
      stopped = true
      controller?.abort()
      await loop.catch(() => {})
    },
  }
}
