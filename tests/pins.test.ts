import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
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

/**
 * The declared Node range is the toolchain's own, not a guess (KV-134).
 *
 * `engines.node` said `>=20.12` long after vitest 5 stopped supporting Node
 * 20, and nothing noticed: CI pins Node 24, and a green run cannot tell a
 * right floor from a stale one. So the range is derived here from what every
 * direct dependency itself declares, and the declared one must equal their
 * intersection. When a Dependabot bump raises a floor, this fails and names
 * the Node versions that moved; update `engines.node` and the README with it.
 *
 * Compared on a grid of versions rather than algebraically: every minor of
 * every major from 18 to 30, **plus every boundary any of the ranges names and
 * its patch neighbours**. The minors alone are blind below a minor — jsdom 30's
 * `^22.22.2` is the first floor with a patch, and a wrong `^22.22.9` passed a
 * grid of `.0`s (review of #149). The boundaries come from the ranges
 * themselves, so a new floor is sampled without anyone adding it here.
 *
 * **Equal, not merely inside**, and that is a choice with a price (review of
 * #149). "No wider" catches the real bug — claiming a Node the toolchain
 * refuses. "No narrower" also fails a range that is only cautious, which means
 * every dev-dependency floor bump turns its Dependabot PR red. That PR cannot
 * be fixed in place — pushing to a Dependabot PR stops it rebasing — so it is
 * closed and replaced by a hand-written one carrying the bump and the new
 * floor together (#119 → KV-148). That recurring replacement is accepted as
 * the price of a declared range that is never stale.
 */
describe('the declared Node range (KV-134)', () => {
  const declared = (pkg as { engines: { node: string } }).engines.node
  const deps = {
    ...(pkg.dependencies as Deps),
    ...(pkg.devDependencies as Deps),
  }
  const toolchain = Object.keys(deps).flatMap((name) => {
    const manifest = JSON.parse(
      readFileSync(join('node_modules', name, 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } }
    const node = manifest.engines?.node
    return node === undefined ? [] : [{ name, node }]
  })
  const minors = Array.from({ length: 13 }, (_, i) => i + 18).flatMap((major) =>
    Array.from({ length: 41 }, (_, minor) => `${major}.${minor}.0`),
  )
  // Each comparator's version (`>=22.22.2`, `<23.0.0-0`) and the patches either
  // side of it, from the declared range and every dependency's.
  const boundaries = [declared, ...toolchain.map((t) => t.node)].flatMap((range) =>
    new semver.Range(range).set.flat().flatMap(({ semver: edge }) => {
      if (typeof edge === 'symbol') return []
      const { major, minor, patch } = edge
      return [patch, patch + 1, ...(patch > 0 ? [patch - 1] : [])].map(
        (p) => `${major}.${minor}.${p}`,
      )
    }),
  )
  const grid = [...new Set([...minors, ...boundaries])]

  it('is what the toolchain supports, no wider and no narrower', () => {
    expect(toolchain.length).toBeGreaterThan(0)
    const disagree = grid.flatMap((version) => {
      const claimed = semver.satisfies(version, declared)
      const refused = toolchain.filter((t) => !semver.satisfies(version, t.node))
      const supported = refused.length === 0
      if (claimed === supported) return []
      return [
        claimed
          ? `${version}: declared, but refused by ${refused.map((t) => `${t.name} (${t.node})`).join(', ')}`
          : `${version}: supported by every package, but not declared`,
      ]
    })
    expect(disagree).toEqual([])
  })

  it('is the range the README tells a contributor', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(`Needs Node \`${declared}\``)
  })
})

/**
 * `@types/node` is held to the Node major Electron ships (review of #150).
 *
 * The `ignore` rule in `dependabot.yml` is what keeps Dependabot from
 * proposing a later major, and a comment is all that would keep the rule: it
 * sits right above the `groups` block, and deleting it while editing that
 * restores the #117/#143 proposals with nothing failing. So both halves are
 * checked here, by reading the files as text.
 *
 * `TYPES_NODE_MAJOR` is the Node major Electron vendors — 24 on Electron 44,
 * from its `DEPS` `node_version`. That cannot be read locally
 * (`node_modules/electron` does not record its Node), so it is stated here and
 * changed by hand with an Electron bump that moves it; KV-127 would derive it.
 */
const TYPES_NODE_MAJOR = 24

describe('@types/node follows Electron’s Node major (review of #150)', () => {
  it('declares and installs that major', () => {
    const declared = (pkg.devDependencies as Deps)['@types/node']
    expect(semver.minVersion(declared ?? '')?.major).toBe(TYPES_NODE_MAJOR)
    expect(semver.major(installed['node_modules/@types/node']?.version ?? '0.0.0')).toBe(
      TYPES_NODE_MAJOR,
    )
  })

  it('keeps Dependabot from proposing a later major', () => {
    const config = readFileSync('.github/dependabot.yml', 'utf8')
    expect(config).toMatch(
      /- dependency-name: "@types\/node"\s*\n\s*update-types: \["version-update:semver-major"\]/,
    )
  })
})
