import type { FastifyInstance } from 'fastify'
import { EXPECTED_SCHEMA_VERSION } from '../migrate'

export function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({
    ok: true,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
  }))
}
