import type { QueryFn } from '../db'

// WS 事件唯一出口：与业务变更同事务调用（传 q），提交后由广播器投递
export async function emitWs(q: QueryFn, type: string, payload: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO ws_outbox (type, payload) VALUES ($1, $2)', [type, JSON.stringify(payload)])
}
