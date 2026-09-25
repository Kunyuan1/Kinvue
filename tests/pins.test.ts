import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
import lock from '../package-lock.json'

/**
 * Electron and the SDK are pinned to exact versions (KV-131).
 *
 * The comment in `.github/dependabot.yml` asks that nobody relax them back to
 * a range, and a comment is all that would stop it: restore a caret by hand,
 * or `npm install electron@45` (which writes `^45.0.0`), and lint, typecheck,
 * the suite and the build all still pass. The same reasoning as
 * `lint-boundary.test.ts` — a green run cannot tell "pinned" from "someone
 * relaxed it" — so it is asserted here instead.
 *
 * Why these two and nothing else is in the dependabot.yml comment: CI cannot
 * prove Electron's native ABI or the SDK's network behaviour, and the build
 * covers everything else.
 */

type Deps = Record<string, string>
const root = lock.packages[''] as { dependencies?: Deps; devDependencies?: Deps }
const installed = lock.packages as Record<string, { version?: string } | undefined>

const PINNED: [name: string, declared: string | undefined, locked: string | undefined][] = [
  ['electron', (pkg.devDependencies as Deps).electron, root.devDependencies?.electron],
  [
    '@smartspectra/node-sdk',
    (pkg.dependencies as Deps)['@smartspectra/node-sdk'],
    root.dependencies?.['@smartspectra/node-sdk'],
  ],
]

describe('exact version pins (KV-131)', () => {
  it.each(PINNED)('pins %s to one version, not a range', (_name, declared) => {
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.each(PINNED)('installs %s at exactly that version', (name, declared, locked) => {
    // A half-reverted pin — package.json exact, lockfile still a range, or a
    // resolved version that no longer matches — fails here rather than on the
    // next `npm ci`.
    expect(locked).toBe(declared)
    expect(installed[`node_modules/${name}`]?.version).toBe(declared)
  })
})
