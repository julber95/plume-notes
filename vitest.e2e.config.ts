// Tests de bout en bout : l'application construite, pilotée dans un vrai
// navigateur (Chromium), face à un faux OneDrive. Lancer avec `npm run test:e2e`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/e2e/**/*.e2e.ts'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false, bail: 1 },
})
