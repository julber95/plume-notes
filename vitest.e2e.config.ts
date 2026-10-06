// End-to-end tests: the built application, driven in a real browser
// (Chromium), against a fake OneDrive. Run with `npm run test:e2e`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/e2e/**/*.e2e.ts'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false, bail: 1 },
})
