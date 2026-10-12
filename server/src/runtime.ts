import type { FastifyInstance } from 'fastify'
import { startSseClient } from './gateway/sse-client'
import { defaultHandlers, processPendingInbox } from './workers/inbox'
import { runDueTasks } from './workers/due-tasks'
import { dueTaskHandlers } from './workers/task-handlers'
import { startWorkers, type WorkerRegistry } from './workers/runner'
import { createWsNotifier } from './workers/ws-notifier'
import { attachWsServer, type WsHub } from './ws/server'

export interface Runtime {
  wsHub: WsHub
  stop: () => Promise<void>
}

/** app 就绪后启动全部后台管线（SSE 摄取、inbox、due tasks、WS 广播） */
export function startRuntime(app: FastifyInstance): Runtime {
  const cfg = app.cfg
  const db = app.db

  const wsHub = attachWsServer(app)
  const wsNotifier = createWsNotifier(db, wsHub)
  const sse = startSseClient({
    db,
    gatewayUrl: cfg.GATEWAY_URL,
    log: (msg) => app.log.info({ msg: `[sse] ${msg}` }),
  })
  const workers: WorkerRegistry = startWorkers(cfg.WORKER_TICK_MS, [
    { name: 'inbox', run: () => processPendingInbox(db, defaultHandlers()) },
    { name: 'due-tasks', run: () => runDueTasks(db, dueTaskHandlers()) },
    { name: 'ws-notifier', run: wsNotifier },
  ])

  return {
    wsHub,
    stop: async () => {
      await sse.stop()
      await workers.stop()
    },
  }
}
