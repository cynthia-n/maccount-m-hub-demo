import { buildGatewayMock } from './app'

const mock = buildGatewayMock()
const port = Number(process.env.GATEWAY_PORT ?? 8081)
mock.app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[gateway-mock] listening on :${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
})
