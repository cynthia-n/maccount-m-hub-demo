// 本地并行起 server + 两个 mock + web；Ctrl-C 整组退出
import { spawn } from 'node:child_process'

const services = [
  ['mocks/gateway', 'gateway'],
  ['mocks/agent', 'agent-mock'],
  ['server', 'server'],
  ['web', 'web'],
]

const children = []
for (const [dir, label] of services) {
  const child = spawn('npm', ['run', 'dev', '-w', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`))
  children.push(child)
}

function shutdown() {
  for (const c of children) c.kill('SIGINT')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
