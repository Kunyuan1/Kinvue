import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// core/ is deliberately free of Electron and React imports, so the suite runs
// in a plain node environment with no DOM shim and no Electron harness.
//
// That stays the default. The screens are the one thing it cannot reach, and
// the failure copy is user-facing output rather than a detail — so a `.tsx`
// test may opt itself into jsdom with a `@vitest-environment` docblock. Nothing
// under core/ may, and the node default is what keeps that honest.
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'core'),
      '@renderer': resolve(__dirname, 'app/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
