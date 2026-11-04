import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import pkg from '../package.json'
import core from '../core/package.json'
import desktop from '../app/package.json'
import config from '../vitest.config'

/**
 * The repo is split into workspaces (KV-38): `core` as the `@kinvue/core` package, and
 * the desktop app as `app`. What #38 said must survive the move, and nothing else
 * would notice going wrong, is held here.
 */

type Manifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

describe('the workspaces (KV-38)', () => {
  it('are core and the desktop app', () => {
    // A new workspace is a decision (the relay, #39; the caregiver app, #42), and the
    // checks below have to learn it, so adding one fails here first.
    expect(pkg.workspaces).toEqual(['core', 'app'])
  })

  it('leave core depending on nothing, an app least of all', () => {
    // The lint rule (KV-15) keeps Electron, React, the SDK and app/ out of core's
    // imports. This keeps them out of its manifest, where a dependency would install
    // with it into every app that uses it — the relay included.
    const { dependencies, devDependencies, peerDependencies, optionalDependencies } =
      core as Manifest
    expect({ dependencies, devDependencies, peerDependencies, optionalDependencies }).toEqual({
      dependencies: undefined,
      devDependencies: undefined,
      peerDependencies: undefined,
      optionalDependencies: undefined,
    })
  })

  it('bundle core into the desktop app, never leave it to be loaded at run time', () => {
    // electron-vite's externalizeDepsPlugin leaves every `dependencies` entry as a
    // `require` in the bundle, and electron-builder packs them. Core is TypeScript
    // source with no build of its own, so as a dependency, with the plugin configured
    // as it is, the installed app would try to load `.ts` files and fail to start. As a
    // dev dependency it is bundled; the alternative, an `exclude`, is in
    // app/electron.vite.config.ts.
    //
    // `*`, never a version (review of #214). npm resolves a workspace locally only while
    // its version satisfies the range; past it, npm goes to the registry, where the
    // install fails on a 404, or, if anyone ever publishes the name, installs theirs.
    const { dependencies, devDependencies } = desktop as Manifest
    expect(dependencies?.['@kinvue/core']).toBeUndefined()
    expect(devDependencies?.['@kinvue/core']).toBe('*')
  })

  it('typecheck core with no DOM in its library', () => {
    // core/tsconfig.json says so, and README and ARCHITECTURE.md repeat it. Without this,
    // adding "DOM" back, or deleting the override so the base's DOM is inherited, passes
    // every check while the docs go on claiming it (review of #214). The file is JSONC,
    // so it is read rather than imported; its comments are whole lines.
    const text = readFileSync(resolve(__dirname, '../core/tsconfig.json'), 'utf8')
    const tsconfig = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
      compilerOptions?: { lib?: string[] }
    }
    expect(tsconfig.compilerOptions?.lib).toEqual(['ES2023'])
  })

  it('keep the desktop app named kinvue, so its history stays where it was', () => {
    // Electron names the user-data folder after the app's package (`%APPDATA%\kinvue`),
    // and the history, the API key and the protection all live there. Renaming the
    // package would start every install on an empty history, with the old one left
    // behind and nothing on screen saying so.
    expect(desktop.name).toBe('kinvue')
    expect(pkg.name).not.toBe('kinvue')
  })

  it('are each typechecked by the one typecheck the hook and CI run', () => {
    for (const workspace of pkg.workspaces) {
      expect(pkg.scripts.typecheck).toContain(`tsc -p ${workspace} `)
    }
    expect(pkg.scripts.typecheck).toMatch(/tsc -p \.$/)
  })

  it('each have a project in the one test run the hook and CI run', () => {
    // A workspace with no project here would have its tests skipped, green.
    const roots = (config.test?.projects ?? []).map((project) =>
      typeof project === 'object' && 'test' in project ? project.test?.root : undefined,
    )
    for (const workspace of pkg.workspaces) {
      expect(roots).toContain(resolve(__dirname, '..', workspace))
    }
  })
})
