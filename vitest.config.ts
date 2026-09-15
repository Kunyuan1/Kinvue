import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// core/ is deliberately free of Electron and React imports, so the suite runs
// in a plain node environment with no DOM shim and no Electron harness.
export default defineConfig({
  resolve: { alias: { '@core': resolve(__dirname, 'core') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
