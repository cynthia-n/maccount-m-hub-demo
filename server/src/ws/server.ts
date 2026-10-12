import { WebSocketServer, type WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import { sha256 } from '../plugins/auth'

interface WsClient {
  socket: WebSocket
  userId: string
  role: 'admin' | 'viewer'
  ready: boolean
}

export interface WsHub {
  broadcast: (frame: { seq: number; type: string; payload: unknown }) => void
  clientCount: () => number
}

// WS /ws：先收 auth 帧，成功后按 seq 推送；sinceSeq 用于断线补齐（B4）
export function attachWsServer(app: FastifyInstance): WsHub {
  const wss = new WebSocketServer({ server: app.server, path: '/ws' })
  const clients = new Set<WsClient>()

  wss.on('connection', (socket) => {
    let client: WsClient | null = null

    socket.on('message', async (raw) => {
      let frame: { type?: string; accessToken?: string; sinceSeq?: number }
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        socket.send(JSON.stringify({ type: 'auth', success: false, message: 'invalid json' }))
        socket.close()
        return
      }
      if (client) return // 已认证，忽略后续帧

      if (frame.type !== 'auth' || !frame.accessToken) {
        socket.send(JSON.stringify({ type: 'auth', success: false, message: 'expected auth frame' }))
        socket.close()
        return
      }
      const { rows } = await app.db.query<{
        user_id: string
        role: 'admin' | 'viewer'
        expired: boolean
        revoked: boolean
      }>(
        `SELECT at.user_id, u.role, (at.expires_at < now()) AS expired, (s.revoked_at IS NOT NULL) AS revoked
           FROM access_tokens at
           JOIN auth_sessions s ON s.id = at.session_id
           JOIN users u ON u.id = at.user_id
          WHERE at.token_hash = $1`,
        [sha256(frame.accessToken)],
      )
      const row = rows[0]
      if (!row || row.expired || row.revoked) {
        socket.send(JSON.stringify({ type: 'auth', success: false, message: 'unauthorized' }))
        socket.close()
        return
      }
      client = { socket, userId: row.user_id, role: row.role, ready: true }
      clients.add(client)
      socket.send(JSON.stringify({ type: 'auth', success: true }))

      // B4 断线补齐：补发 sinceSeq 之后的事件（保证顺序，之后接到实时流）
      const sinceSeq = Number(frame.sinceSeq ?? 0)
      if (sinceSeq > 0 || frame.sinceSeq === 0) {
        const { rows: backlog } = await app.db.query<{ seq: string; type: string; payload: unknown }>(
          'SELECT seq, type, payload FROM ws_outbox WHERE seq > $1 ORDER BY seq',
          [sinceSeq],
        )
        for (const row of backlog) {
          socket.send(JSON.stringify({ seq: Number(row.seq), type: row.type, payload: row.payload }))
        }
      }
    })

    socket.on('close', () => {
      if (client) clients.delete(client)
    })
    socket.on('error', () => {
      if (client) clients.delete(client)
    })
  })

  return {
    broadcast: (frame) => {
      const data = JSON.stringify(frame)
      for (const c of clients) {
        if (c.ready && c.socket.readyState === c.socket.OPEN) {
          c.socket.send(data)
        }
      }
    },
    clientCount: () => clients.size,
  }
}
