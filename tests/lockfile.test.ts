import { describe, expect, it } from 'vitest'
import lock from '../package-lock.json'

/**
 * Every package the lockfile installs is recorded as the canonical tarball of
 * that package, at that version, on the public npm registry, with an integrity
 * hash (review of #141).
 *
 * `npm ci` fetches what `resolved` says and checks it against `integrity`. So
 * an edit that repoints one entry — at another host, or at another package's
 * genuine tarball on npm, with a matching hash and the version left alone —
 * passes lint, typecheck, the suite and the build, and installs. The version
 * pins in `pins.test.ts` cannot see it: this is about where a package comes
 * from, which is a property of every entry, not of the two pinned ones. An
 * attacker choosing which entry to edit has no reason to pick those.
 *
 * **What this proves, and what it does not.** It proves the *lockfile records*
 * the public registry's canonical URL for each package. It does not prove
 * where a given install fetches from: npm rewrites `registry.npmjs.org` to
 * whatever registry is configured (`replace-registry-host` defaults to
 * `npmjs`), so a machine with a proxy registry in `~/.npmrc` fetches every
 * byte from the proxy with this test green. The `integrity` hash is what holds
 * across that rewrite.
 */

type Entry = {
  name?: string
  version?: string
  resolved?: string
  integrity?: string
  inBundle?: boolean
  link?: boolean
}

/** Installed entries: bundled ones ship inside their parent's tarball, links point at the tree. */
const installed = Object.entries(lock.packages as Record<string, Entry>).filter(
  ([path, entry]) => path !== '' && entry.inBundle !== true && entry.link !== true,
)

/** The package an entry installs: an alias records its real name, otherwise the path says it. */
const nameOf = (path: string, entry: Entry): string =>
  entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)

/** Where npm publishes `name@version`: `/<name>/-/<unscoped name>-<version>.tgz`. */
const canonical = (name: string, version: string | undefined): string =>
  `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`

describe('where the lockfile says each package comes from', () => {
  it('has entries to check', () => {
    // A lockfile shape this cannot read must fail, not pass on an empty list.
    expect(installed.length).toBeGreaterThan(100)
  })

  it("records every package as that package's own tarball on the public registry", () => {
    const wrong = installed
      .filter(([path, entry]) => entry.resolved !== canonical(nameOf(path, entry), entry.version))
      .map(([path, entry]) => `${path}: ${entry.resolved ?? '(no resolved)'}`)
    expect(wrong).toEqual([])
  })

  it('gives every package an integrity hash, which is what holds across a registry rewrite', () => {
    const missing = installed
      .filter(([, entry]) => !/^sha512-/.test(entry.integrity ?? ''))
      .map(([path]) => path)
    expect(missing).toEqual([])
  })
})
