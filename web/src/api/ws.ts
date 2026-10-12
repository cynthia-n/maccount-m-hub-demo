// WS hook：auth 帧 → 实时事件 + sinceSeq 断线补齐（B4：重连 3 秒内出现且不重复）
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { auth } from './client'

export function useRealtime(enabled: boolean): void {
  const qc = useQueryClient()
  const lastSeqRef = useRef(0)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let backoff = 500

    const invalidate = (keys: string[]) => {
      for (const k of keys) void qc.invalidateQueries({ queryKey: [k] })
    }

    const connect = () => {
      if (stopped) return
      const token = auth.get().accessToken
      if (!token) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      socketRef.current = ws

      ws.onopen = () => {
        backoff = 500
        ws.send(JSON.stringify({ type: 'auth', accessToken: token, sinceSeq: lastSeqRef.current || undefined }))
      }
      ws.onmessage = (ev) => {
        let frame: { seq?: number; type?: string; payload?: Record<string, unknown> }
        try {
          frame = JSON.parse(ev.data as string)
        } catch {
          return
        }
        if (frame.type === 'auth') return // auth ack
        if (typeof frame.seq === 'number') {
          if (frame.seq <= lastSeqRef.current) return // 补齐去重（B4）
          lastSeqRef.current = frame.seq
        }
        switch (frame.type) {
          case 'account_status_changed':
          case 'account_terminal':
            invalidate(['accounts'])
            break
          case 'message':
            invalidate(['messages', 'groups'])
            break
          case 'agent_run':
            invalidate(['agent-runs', 'agent-run', 'groups'])
            break
          case 'sequence_run':
            invalidate(['sequence-run', 'groups'])
            break
          case 'inconsistency':
            invalidate(['accounts', 'groups'])
            break
        }
      }
      ws.onclose = () => {
        if (!stopped) {
          setTimeout(connect, backoff)
          backoff = Math.min(backoff * 2, 5000)
        }
      }
    }
    connect()

    return () => {
      stopped = true
      socketRef.current?.close()
    }
  }, [enabled, qc])
}
