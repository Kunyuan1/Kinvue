import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// One run over every workspace (KV-38), so `npm test`, the pre-commit hook and CI
// stay the same command. Each project names its own tests; a workspace added
// without a project here runs no tests, and `tests/workspaces.test.ts` fails.
//
// core/ is deliberately free of Electron and React imports, so its suite runs
// in a plain node environment with no DOM shim and no Electron harness, and
// nothing under core/ may opt out of that.
//
// The app's default is node too. The screens are the one thing it cannot
// reach, and the failure copy is user-facing output rather than a detail — so
// an app `.tsx` test may opt itself into jsdom with a `@vitest-environment`
// docblock.
// The same pattern in every project, `.tsx` included, so no test file is left that no
// project collects (review of #214). A `.tsx` test under core/ still runs in node, and
// the lint rule refuses React there, so it could not render anything.
const TESTS = ['tests/**/*.test.ts', 'tests/**/*.test.tsx']

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: resolve(__dirname, 'core'),
          environment: 'node',
          include: TESTS,
        },
      },
      {
        resolve: { alias: { '@renderer': resolve(__dirname, 'app/renderer') } },
        test: {
          name: 'app',
          root: resolve(__dirname, 'app'),
          environment: 'node',
          include: TESTS,
        },
      },
      {
        test: {
          name: 'repo',
          root: __dirname,
          environment: 'node',
          include: TESTS,
        },
      },
    ],
  },
})
