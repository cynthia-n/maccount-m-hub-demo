// M0 占位：agent 模拟器在 M5 实现（接口契约见 docs/API.md §3）
import fastify from 'fastify'

const app = fastify({ logger: true })
app.get('/api/health', async () => ({ ok: true, service: 'agent-mock' }))

const port = Number(process.env.AGENT_MOCK_PORT ?? 8082)
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  console.error(err)
  process.exit(1)
})
