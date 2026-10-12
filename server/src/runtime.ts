import type { FastifyInstance } from 'fastify'
import { startSseClient } from './gateway/sse-client'
import { defaultHandlers, processPendingInbox } from './workers/inbox'
import { runDueTasks } from './workers/due-tasks'
import { dueTaskHandlers } from './workers/task-handlers'
import { pollJobs } from './domain/jobs'
import { pumpOutbound, resolveUnknown } from './domain/outbound'
import { pollAgentRuns } from './domain/agent'
import { AgentClient } from './agent/client'
import { startWorkers, type WorkerRegistry } from './workers/runner'
import { createWsNotifier } from './workers/ws-notifier'
import { attachWsServer, type WsHub } from './ws/server'

export interface Runtime {
  wsHub: WsHub
  stop: () => Promise<void>
}

/** app 就绪后启动全部后台管线（SSE 摄取、inbox、due tasks、outbound、agent、WS 广播） */
export async function startRuntime(app: FastifyInstance): Promise<Runtime> {
  const cfg = app.cfg
  const db = app.db

  const wsHub = attachWsServer(app)
  const wsNotifier = createWsNotifier(db, wsHub)

  // A5.2 停机时间不计入 agent 60s 墙钟：以心跳差值平移 running run 的 deadline
  const { rows: hb } = await db.query<{ value: string }>("SELECT value FROM meta WHERE key='heartbeat'")
  if (hb[0]) {
    const downtimeMs = Date.now() - Number(hb[0].value)
    if (downtimeMs > 2000) {
      await db.query(
        `UPDATE agent_runs SET deadline_at = deadline_at + make_interval(secs => $1) WHERE status='running'`,
        [downtimeMs / 1000],
      )
    }
  }

  const agentClient = new AgentClient(cfg.AGENT_URL)
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
    { name: 'agent', run: () => pollAgentRuns(db, agentClient, app.gateway, cfg) },
    {
      name: 'heartbeat',
      run: async () => {
        await db.query(
          `INSERT INTO meta (key, value) VALUES ('heartbeat', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [String(Date.now())],
        )
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
