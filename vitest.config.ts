import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@mhub/shared': fileURLToPath(new URL('./shared/src', import.meta.url)),
    },
  },
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'mocks/**/*.test.ts'],
    // 集成测试共用一个测试库，串行执行避免互踩；用例本身都是毫秒级
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
    },
  },
})
