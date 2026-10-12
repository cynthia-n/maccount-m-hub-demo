// M0 占位：完整网关模拟器在 M1 实现（接口契约见 docs/API.md §2）
import fastify from 'fastify'

const app = fastify({ logger: true })
app.get('/api/health', async () => ({ ok: true, service: 'gateway-mock' }))

const port = Number(process.env.GATEWAY_PORT ?? 8081)
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  console.error(err)
  process.exit(1)
})
