import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
import lock from '../package-lock.json'

/**
 * Electron and the SDK are pinned to exact versions (KV-131), and so is
 * electron-builder (KV-19), which packages, fuses and will sign the app.
 *
 * The comment in `.github/dependabot.yml` asks that nobody relax them back to
 * a range, and a comment is all that would stop it: restore a caret by hand,
 * or `npm install electron@45` (which writes `^45.0.0`), and lint, typecheck,
 * the suite and the build all still pass. The same reasoning as
 * `lint-boundary.test.ts` — a green run cannot tell "pinned" from "someone
 * relaxed it" — so it is asserted here instead.
 *
 * Why these three and nothing else is in the dependabot.yml comment: CI cannot
 * prove Electron's native ABI or the SDK's network behaviour, and never builds
 * the installer; the build covers everything else.
 */

type Deps = Record<string, string>
const root = lock.packages[''] as { dependencies?: Deps; devDependencies?: Deps }
const installed = lock.packages as Record<string, { version?: string } | undefined>

const PINNED: [name: string, declared: string | undefined, locked: string | undefined][] = [
  ['electron', (pkg.devDependencies as Deps).electron, root.devDependencies?.electron],
  // KV-19: it packages, fuses and (later) signs the app, so a range would let
  // a release change what is shipped and how without anyone deciding to.
  [
    'electron-builder',
    (pkg.devDependencies as Deps)['electron-builder'],
    root.devDependencies?.['electron-builder'],
  ],
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

  it('leaves room for four open majors beside every PR that arrives alone (review of #193)', () => {
    // Each package left out of the group is a PR of its own, standing open
    // beside the group's; past the limit Dependabot opens nothing and says
    // nothing. Pinning another package must raise the limit with it.
    const yml = readFileSync('.github/dependabot.yml', 'utf8')
    const excluded = /minor-and-patch:[\s\S]*?exclude-patterns: \[([^\]]*)\]/.exec(yml)?.[1] ?? ''
    const alone = excluded.split(',').filter((p) => p.trim() !== '').length
    const limit = Number(/open-pull-requests-limit: (\d+)/.exec(yml)?.[1])
    expect(alone).toBeGreaterThan(0)
    expect(limit - (alone + 1)).toBeGreaterThanOrEqual(4)
  })

  it.each(PINNED)('keeps %s out of the routine group, so each bump arrives alone', (name) => {
    // A pinned package bumped inside the group's PR is a version change in a
    // chore nobody reads as one — the thing the pin is for (dependabot.yml).
    const yml = readFileSync('.github/dependabot.yml', 'utf8')
    const excluded = /minor-and-patch:[\s\S]*?exclude-patterns: \[([^\]]*)\]/.exec(yml)?.[1] ?? ''
    const pattern = name.startsWith('@smartspectra/') ? '"@smartspectra/*"' : `"${name}"`
    expect(excluded).toContain(pattern)
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
 * `TYPES_NODE_MAJOR` and `TYPES_NODE_MINOR` are the Node the pinned Electron
 * vendors, and `TYPES_NODE_READ_FROM` is the Electron whose binary they were
 * read from — the one place either is written down, so prose elsewhere points
 * here (review of #153), and a reader can always tell which Electron the
 * ceiling describes (review of #160). Package metadata does not record the
 * Node — `node_modules/electron` has no Node version, and no binary until
 * first use — so a unit test cannot read it, and CI would have to fetch the
 * binary (KV-127). The binary can, and README's Electron-bump launch reads it
 * there and compares it with these.
 *
 * `TYPES_NODE_READ_FROM` is recorded, not asserted equal to the pin. It stays
 * true when a later Electron leaves the Node where it was — these were read
 * from that binary — and changes only with them, in the hand-written PR that
 * replaces a bump that moved it. Asserting
 * it would turn every Electron Dependabot PR red, security patches included,
 * each to be closed and replaced by hand — the delay `dependabot.yml` keeps
 * Electron out of the group to avoid. Decided by the owner in review of #160:
 * the record, and the derived check below, which does fail in CI.
 *
 * **When an Electron bump moves that Node, the Dependabot PR carrying it cannot
 * update these** — nothing may be pushed to one (CLAUDE.md). Close it and open
 * a hand-written PR with the bump and the new constants together, as #119 was
 * replaced by KV-148 for `engines.node`. Merging it as it is leaves the ceiling
 * too low (types held back for nothing) and this comment wrong. The same goes
 * when an Electron release raises the floor of its own `@types/node` range
 * past the ceiling, which the test below reports directly.
 *
 * **The minor is a proxy for the risk, not a bound on it** (review of #160).
 * The risk is main-process code compiling against a Node API the packaged app
 * lacks, while CI passes on Node 22 and 24 alike (KV-159, review of #152).
 * `@types/node`'s minor is DefinitelyTyped's release number, not Node's: it
 * skips minors (24.13 was followed by 24.19), and a type for an API from a
 * later Node could land in a patch under the ceiling and pass. It holds back
 * the common case cheaply, and that is all it claims. The floor of the safe
 * band — the types' minor under `engines.node`'s Node 24 floor — is not
 * asserted: it fails closed, since an API the types lack fails `npm run
 * typecheck`.
 */
const TYPES_NODE_MAJOR = 24
const TYPES_NODE_MINOR = 21
const TYPES_NODE_READ_FROM = '44.4.5'

/** A version the lockfile or manifest must hold; failing loudly, never defaulting to one that passes. */
function required(value: string | undefined, what: string): string {
  expect(value, `${what} is missing`).toBeTypeOf('string')
  return value ?? ''
}

describe('@types/node follows Electron’s Node (review of #150, KV-159)', () => {
  const ceiling = `<=${TYPES_NODE_MAJOR}.${TYPES_NODE_MINOR}.x`
  const dependabot = (): string => readFileSync('.github/dependabot.yml', 'utf8')

  it('declares and installs that major', () => {
    const declared = required((pkg.devDependencies as Deps)['@types/node'], 'declared @types/node')
    const version = required(installed['node_modules/@types/node']?.version, 'installed @types/node')
    expect(semver.minVersion(declared)?.major).toBe(TYPES_NODE_MAJOR)
    expect(semver.major(version)).toBe(TYPES_NODE_MAJOR)
  })

  it('declares and installs no later minor than Electron’s Node (KV-159)', () => {
    const declared = required((pkg.devDependencies as Deps)['@types/node'], 'declared @types/node')
    const floor = required(semver.minVersion(declared)?.version, `the floor of ${declared}`)
    const version = required(installed['node_modules/@types/node']?.version, 'installed @types/node')
    // `x.y.*` rather than `<=x.y.0`: a types patch within the vendored minor is fine.
    expect(semver.satisfies(floor, ceiling), `declared ${declared}`).toBe(true)
    expect(semver.satisfies(version, ceiling), `installed ${version}`).toBe(true)
  })

  it('sits over the @types/node floor Electron itself declares (review of #160)', () => {
    // Electron's own `@types/node` range is a lower bound on the Node it
    // vendors, and unlike the binary it is in the lockfile, so CI can read it.
    // A ceiling under it means these constants are stale: an Electron bump
    // raised its Node, and the PR that carried it should have been replaced.
    const electron = lock.packages['node_modules/electron'] as { dependencies?: Deps }
    const range = required(electron.dependencies?.['@types/node'], 'electron’s @types/node')
    const floor = required(semver.minVersion(range)?.version, `the floor of ${range}`)
    expect(semver.satisfies(floor, ceiling), `electron needs ${range}`).toBe(true)
  })

  it('records the Electron it was read from as a version, never a range', () => {
    expect(semver.valid(TYPES_NODE_READ_FROM)).toBe(TYPES_NODE_READ_FROM)
  })

  it('arrives alone, so a bump past the ceiling holds up nothing else (KV-159)', () => {
    // Anchored to the group it must be excluded from: the first
    // `exclude-patterns` in the file could belong to another group (review of #160).
    const excluded = /minor-and-patch:[\s\S]*?exclude-patterns: \[([^\]]*)\]/.exec(dependabot())
    expect(required(excluded?.[1], 'minor-and-patch exclude-patterns')).toContain('"@types/node"')
  })

  it('keeps Dependabot from proposing a later major', () => {
    expect(dependabot()).toMatch(
      /- dependency-name: "@types\/node"\s*\n\s*update-types: \["version-update:semver-major"\]/,
    )
  })
})
