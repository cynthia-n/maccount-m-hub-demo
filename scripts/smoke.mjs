// 端到端冒烟：真实进程跑一遍 登录→connect→建群→发消息→断言 sent。
// 前置：docker compose up -d（PG 就绪）。使用 maccount_test 库，不影响开发数据。
import { spawn } from 'node:child_process'

const PORT_S = 18080
const PORT_GW = 18081
const PORT_AG = 18082
const DB = 'postgres://maccount:maccount@127.0.0.1:54329/maccount_test'
const BASE = `http://127.0.0.1:${PORT_S}`

const children = []
function start(name, args, env) {
  const c = spawn('npx', ['tsx', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  c.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[${name}] ${d}`))
  c.stderr.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
  children.push(c)
  return c
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) throw new Error(`${label} 未就绪`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function pollUntil(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`smoke 断言超时: ${label}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

function fail(msg) {
  console.error(`smoke FAIL: ${msg}`)
  for (const c of children) c.kill('SIGINT')
  process.exit(1)
}

async function main() {
  // 1. 全新迁移测试库
  const mig = spawn('npx', ['tsx', 'server/src/migrate-cli.ts', 'fresh'], {
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'inherit',
  })
  await new Promise((res, rej) => mig.on('close', (code) => (code === 0 ? res() : rej(new Error('migrate failed')))))

  // 2. 起真实进程
  start('gateway', ['mocks/gateway/src/index.ts'], { GATEWAY_PORT: PORT_GW })
  start('agent', ['mocks/agent/src/index.ts'], { AGENT_MOCK_PORT: PORT_AG })
  start('server', ['server/src/index.ts'], {
    PORT: PORT_S, DATABASE_URL: DB, GATEWAY_URL: `http://127.0.0.1:${PORT_GW}`, AGENT_URL: `http://127.0.0.1:${PORT_AG}`,
  })
  await waitFor(`${BASE}/api/health`, 20000, 'server')
  await waitFor(`http://127.0.0.1:${PORT_GW}/api/health`, 5000, 'gateway')

  // 3. 冒烟旅程
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (!login.ok) fail('登录失败')
  const token = (await login.json()).accessToken
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  for (const id of ['acc-alpha', 'acc-bravo']) {
    const r = await fetch(`${BASE}/api/accounts/${id}/connect`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    if (!r.ok) fail(`connect ${id} 失败: ${r.status} ${await r.text()}`)
  }

  const created = await fetch(`${BASE}/api/groups`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ creatorAccountId: 'acc-alpha', memberAccountIds: ['acc-bravo'] }),
  })
  if (created.status !== 202) fail('建群提交失败')
  const { jobId } = await created.json()

  const job = await pollUntil('建群 job', async () => {
    const j = await (await fetch(`${BASE}/api/jobs/${jobId}`, { headers: H })).json()
    return j.status === 'finished' ? j : null
  })
  if (job.status !== 'finished') fail(`建群 job ${job.status}`)

  const groups = await (await fetch(`${BASE}/api/groups`, { headers: H })).json()
  const group = groups[0]
  if (!group?.gatewayGroupId || group.members.length !== 2) fail('建群结果不对')

  const sent = await fetch(`${BASE}/api/groups/${group.id}/send`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ accountId: 'acc-bravo', text: 'smoke hello' }),
  })
  if (sent.status !== 202) fail('发送失败')
  const { clientMsgId } = await sent.json()

  const delivered = await pollUntil('消息 sent', async () => {
    const list = await (await fetch(`${BASE}/api/groups/${group.id}/messages?limit=10`, { headers: H })).json()
    const m = list.items.find((i) => i.clientMsgId === clientMsgId)
    return m?.deliveryStatus === 'sent' ? m : null
  })

  console.log(`smoke PASS: 登录/建群(${group.gatewayGroupId})/发消息(${delivered.msgId}) 全链路 OK`)
  for (const c of children) c.kill('SIGINT')
  process.exit(0)
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
