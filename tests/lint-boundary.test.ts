import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * That the `core/` import guard still fires (KV-129).
 *
 * `core/` stays free of Electron, React, the renderer, the SDK and `app/`
 * (KV-15), and the only thing enforcing it is `eslint.config.mjs`: a
 * `no-restricted-imports` block for what may be imported, and a
 * `no-restricted-syntax` block that keeps every load static so the first one
 * can see it. For any other dependency a green run means the code still works;
 * for the linter it cannot tell "nothing is imported" from "the rule stopped
 * matching". An exact `paths` entry once let `electron/main` straight past it.
 * So an eslint or typescript-eslint bump — which arrives in the grouped
 * Dependabot PR — is checked here, not trusted on its version number.
 *
 * **Tied to the config, not a copy of it.** The last test reads the resolved
 * rule options and fails if any configured group or banned syntax has no
 * probe here, so adding a sixth group without a probe is a red build rather
 * than a guard nobody tests. That couples this file to the rules' option
 * shape: a linter that restructures its options will fail it for a reason
 * that is not a regression. That is deliberate — a linter bump is exactly when
 * someone should read this config.
 *
 * Linted as text at paths that do not exist: the config is not type-aware,
 * so a path only has to match `core/**` for the rules to apply. If `core/`
 * ever moves to `projectService`, `lintText` at a missing path will start
 * erroring rather than degrading, and `guard` will say so. Nothing is written
 * to disk, and nothing here imports `core/`.
 */

const eslint = new ESLint()

const IMPORTS = 'no-restricted-imports'
const SYNTAX = 'no-restricted-syntax'

/**
 * What the guard reported for `source` linted as `filePath`.
 *
 * Throws rather than returning nothing when the file was not really linted —
 * a parse failure, or a path the config ignores both report with no rule id.
 * Filtering those away would turn "never linted" into "nothing to report",
 * and the controls below, which expect nothing, would pass on it.
 */
async function guard(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath })
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`)
  const unlinted = result.messages.filter((m) => m.fatal === true || m.ruleId === null)
  if (unlinted.length > 0) {
    throw new Error(`${filePath} was not linted: ${unlinted.map((m) => m.message).join('; ')}`)
  }
  return result.messages
    .filter((m) => m.ruleId === IMPORTS || m.ruleId === SYNTAX)
    .map((m) => m.message)
}

const IN_CORE = 'core/session/__lint_probe__.ts'
/** The config's `core/**` glob covers `.tsx` too, though nothing there uses it yet. */
const IN_CORE_TSX = 'core/ui/__lint_probe__.tsx'
const OUTSIDE_CORE = 'app/main/__lint_probe__.ts'

/** What it is, the source, and a fragment of the message it must produce. */
type Probe = [what: string, source: string, says: string]

const ELECTRON = 'must not import Electron'
const REACT = 'must not import React'
const RENDERER = 'must not reach into the renderer'
const SDK = 'must not import the SDK'
const APP = 'must not import from app/'

/** The static forms `no-restricted-imports` exists to stop. */
const STATIC: Probe[] = [
  ['Electron', "import { app } from 'electron'", ELECTRON],
  ['an Electron subpath, the form that once walked past it', "import { app } from 'electron/main'", ELECTRON],
  ['an Electron type', "import type { BrowserWindow } from 'electron'", ELECTRON],
  ['an Electron side-effect import', "import 'electron'", ELECTRON],
  ['an Electron re-export', "export { app } from 'electron'", ELECTRON],
  ['React', "import { useState } from 'react'", REACT],
  ['React DOM', "import { createRoot } from 'react-dom/client'", REACT],
  ['a React type', "import type { ReactNode } from 'react'", REACT],
  ['a React star re-export', "export * from 'react'", REACT],
  ['a testing library named for React', "import { render } from '@testing-library/react'", REACT],
  ['the renderer', "import App from '@renderer/App'", RENDERER],
  ['the SDK', "import { SmartSpectraSDK } from '@smartspectra/node-sdk'", SDK],
  ['an SDK subpath', "import { decodeMetrics } from '@smartspectra/node-sdk/messages'", SDK],
  ['app/ by a relative path', "import { createVitalsAccumulator } from '../../app/main/metrics'", APP],
  ['app/ one level up', "import { x } from '../app/main/vitals'", APP],
]

/** The dynamic forms, which `no-restricted-imports` cannot see (KV-129 review). */
const DYNAMIC: Probe[] = [
  [
    'a deferred SDK import, the likeliest way round the static rule',
    "export const load = async () => await import('@smartspectra/node-sdk/messages')",
    'dynamic import()',
  ],
  [
    'a dynamic import of a computed name',
    'export const load = (name: string) => import(name)',
    'dynamic import()',
  ],
  ['require()', "export const e = require('electron')", 'require()'],
  [
    'createRequire()',
    "import { createRequire } from 'node:module'\n" +
      "export const e = createRequire(import.meta.url)('electron')",
    'createRequire()',
  ],
  ['import x = require()', "import e = require('electron')\nexport { e }", 'import x = require()'],
]

const ALL = [...STATIC, ...DYNAMIC]

/** Imports core/ may use. `@core/*` is not a live spelling inside core/ yet; it is here in case it becomes one. */
const ALLOWED: [string][] = [
  ["import { readFile } from 'node:fs/promises'"],
  ["import { computeBaseline } from '../baseline'"],
  ["import { scoreSession } from '@core/scoring'"],
]

beforeAll(async () => {
  // ESLint resolves the config on the first lint, not in its constructor, and
  // that load is most of this file's time. Taken here, under its own timeout,
  // so it cannot push whichever case runs first past Vitest's 5 s default and
  // read as the guard breaking.
  await guard('', IN_CORE)
}, 30_000)

describe('the core/ import guard (KV-15)', () => {
  it.each(ALL)('reports %s', async (_what, source, says) => {
    const reports = await guard(source, IN_CORE)
    expect(reports.length).toBeGreaterThan(0)
    expect(reports.some((m) => m.includes(says)), reports.join(' | ')).toBe(true)
  })

  it('applies to .tsx under core/ as well', async () => {
    expect((await guard("import { app } from 'electron'", IN_CORE_TSX)).join()).toContain(ELECTRON)
  })

  it.each(ALL)('does not report %s outside core/', async (_what, source) => {
    // Otherwise a rule that fired on every file would pass the tests above.
    expect(await guard(source, OUTSIDE_CORE)).toEqual([])
  })

  it.each(ALLOWED)('does not report %s inside core/', async (source) => {
    expect(await guard(source, IN_CORE)).toEqual([])
  })

  it('refuses to call a file clean when it was never linted', async () => {
    // What keeps the "reports nothing" controls honest (KV-129 review): a path
    // the config ignores, or a file that does not parse, has no rule id to
    // filter on and would otherwise read as clean.
    await expect(guard("import { app } from 'electron'", 'out/__lint_probe__.ts')).rejects.toThrow(
      /was not linted/,
    )
    await expect(guard("import { app from 'electron'", IN_CORE)).rejects.toThrow(/was not linted/)
  })

  it('has a probe for every group and every banned syntax the config holds', async () => {
    const config = (await eslint.calculateConfigForFile(IN_CORE)) as {
      rules: Record<string, [unknown, ...unknown[]]>
    }
    const [, importOptions] = config.rules[IMPORTS] ?? []
    const patterns = (importOptions as { patterns?: { message: string }[] } | undefined)?.patterns
    const [, ...syntaxOptions] = config.rules[SYNTAX] ?? []
    const configured = [
      ...(patterns ?? []).map((p) => p.message),
      ...(syntaxOptions as { message: string }[]).map((s) => s.message),
    ]
    // A shape this cannot read is a loud failure, not an empty list that passes.
    expect(patterns?.length, `${IMPORTS} patterns`).toBeGreaterThan(0)
    expect(syntaxOptions.length, `${SYNTAX} selectors`).toBeGreaterThan(0)

    const unprobed = configured.filter(
      (message) => !ALL.some(([, , says]) => message.includes(says)),
    )
    expect(unprobed, 'configured with no probe in this file').toEqual([])
  })
})
