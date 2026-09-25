import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * That the `core/` import guard still fires (KV-129).
 *
 * `core/` stays free of Electron, React, the renderer, the SDK and `app/`
 * (KV-15), and the only thing enforcing it is one `no-restricted-imports`
 * block in `eslint.config.mjs`. For any other dependency a green run means the
 * code still works; for the linter it cannot tell "nothing is imported" from
 * "the rule stopped matching". An exact `paths` entry once let `electron/main`
 * straight past it. So an eslint or typescript-eslint bump — which arrives in
 * the grouped Dependabot PR — is checked here against every banned form, not
 * trusted on its version number.
 *
 * Linted as text at a path that does not exist: the config is not type-aware,
 * so the path only has to match `core/**` for the rule to apply. Nothing is
 * written to disk, and nothing here imports `core/`.
 */

const eslint = new ESLint({ cwd: process.cwd() })

/** The `no-restricted-imports` reports for `source`, as if it lived at `filePath`. */
async function restricted(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message)
}

const IN_CORE = 'core/session/__lint_probe__.ts'

/** Every form the rule exists to stop, with what it is. */
const BANNED: [string, string][] = [
  ['Electron', "import { app } from 'electron'"],
  ['an Electron subpath, the form that once walked past it', "import { app } from 'electron/main'"],
  ['an Electron type', "import type { BrowserWindow } from 'electron'"],
  ['React', "import { useState } from 'react'"],
  ['React DOM', "import { createRoot } from 'react-dom/client'"],
  ['a React type', "import type { ReactNode } from 'react'"],
  ['a testing library named for React', "import { render } from '@testing-library/react'"],
  ['the renderer', "import App from '@renderer/App'"],
  ['the SDK', "import { SmartSpectraSDK } from '@smartspectra/node-sdk'"],
  ['an SDK subpath', "import { decodeMetrics } from '@smartspectra/node-sdk/messages'"],
  ['app/ by a relative path', "import { createVitalsAccumulator } from '../../app/main/metrics'"],
  ['app/ one level up', "import { x } from '../app/main/vitals'"],
]

describe('the core/ import guard (KV-15)', () => {
  it.each(BANNED)('reports %s', async (_what, source) => {
    expect(await restricted(source, IN_CORE)).toHaveLength(1)
  })

  it('does not report the same imports outside core/', async () => {
    // Otherwise a rule that fired on every file would pass the test above.
    for (const [what, source] of BANNED) {
      expect(await restricted(source, 'app/main/__lint_probe__.ts'), what).toEqual([])
    }
  })

  it('does not report what core/ is allowed to import', async () => {
    // Node built-ins and core/'s own modules. CLAUDE.md: "Node built-ins are not."
    for (const source of [
      "import { readFile } from 'node:fs/promises'",
      "import { computeBaseline } from '../baseline'",
      "import { scoreSession } from '@core/scoring'",
    ]) {
      expect(await restricted(source, IN_CORE), source).toEqual([])
    }
  })
})
