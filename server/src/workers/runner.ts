// worker 注册表：一个 tick 依次跑所有 poller；前一轮未完成则跳过本轮（防堆积）。
// 所有“到期做某事”的扫描都挂在这里；进程重启后自然恢复（状态都在 DB）。
export interface WorkerRegistry {
  stop: () => Promise<void>
}

export function startWorkers(tickMs: number, pollers: Array<{ name: string; run: () => Promise<unknown> }>): WorkerRegistry {
  let running = false
  let stopped = false
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    void (async () => {
      try {
        for (const p of pollers) {
          try {
            await p.run()
          } catch (e) {
            console.error(`[worker:${p.name}]`, e instanceof Error ? e.message : e)
          }
        }
      } finally {
        running = false
      }
    })()
  }, tickMs)

  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
