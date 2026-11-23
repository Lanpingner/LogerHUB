import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/shared/test/**/*.test.ts', 'packages/client/test/**/*.test.ts'],
  },
})
