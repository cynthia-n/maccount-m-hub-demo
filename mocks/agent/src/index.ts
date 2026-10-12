import { buildAgentMock } from './app'

const mock = buildAgentMock()
const port = Number(process.env.AGENT_MOCK_PORT ?? 8082)
mock.app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[agent-mock] listening on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
})
