import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z
    .string()
    .default('postgres://maccount:maccount@127.0.0.1:54329/maccount'),
  DATABASE_TEST_URL: z
    .string()
    .default('postgres://maccount:maccount@127.0.0.1:54329/maccount_test'),
  GATEWAY_URL: z.string().default('http://127.0.0.1:8081'),
  AGENT_URL: z.string().default('http://127.0.0.1:8082'),

  // 可调时序（docs/ARCHITECTURE §12）；测试里调小
  ACCESS_TOKEN_TTL_MS: z.coerce.number().default(15 * 60_000),
  TURN_TIMEOUT_MS: z.coerce.number().default(12_000),
  AUDIT_TIMEOUT_MS: z.coerce.number().default(5_000),
  AUDIT_ATTEMPTS: z.coerce.number().default(3),
  AGENT_SEND_WAIT_MS: z.coerce.number().default(5_000),
  AGENT_MAX_STEPS: z.coerce.number().default(12),
  AGENT_WALL_CLOCK_MS: z.coerce.number().default(60_000),
  UNKNOWN_SETTLE_MS: z.coerce.number().default(2_000),
  UNKNOWN_DEADLINE_MS: z.coerce.number().default(5_000),
  UNKNOWN_POLL_MS: z.coerce.number().default(400),
  JOIN_TIMEOUT_MS: z.coerce.number().default(10_000),
  WORKER_TICK_MS: z.coerce.number().default(250),
  WS_OUTBOX_RETENTION_MS: z.coerce.number().default(2 * 60 * 60_000),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env)
}
