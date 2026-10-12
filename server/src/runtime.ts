import type { FastifyInstance } from 'fastify'
import { startSseClient } from './gateway/sse-client'
import { defaultHandlers, processPendingInbox } from './workers/inbox'
import { runDueTasks } from './workers/due-tasks'
import { dueTaskHandlers } from './workers/task-handlers'
import { pollJobs } from './domain/jobs'
import { pumpOutbound, resolveUnknown } from './domain/outbound'
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
    { name: 'inbox', run: () => processPendingInbox(db, defaultHandlers(app.gateway)) },
    { name: 'due-tasks', run: () => runDueTasks(db, dueTaskHandlers(app.gateway)) },
    { name: 'jobs', run: () => pollJobs(db, app.gateway, app.cfg.JOIN_TIMEOUT_MS) },
    {
      name: 'outbound',
      run: async () => {
        await pumpOutbound(db, app.gateway)
        await resolveUnknown(db, app.gateway, {
          settleMs: cfg.UNKNOWN_SETTLE_MS,
          pollMs: cfg.UNKNOWN_POLL_MS,
        })
      },
    },
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
