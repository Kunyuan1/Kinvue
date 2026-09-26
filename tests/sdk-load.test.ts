import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The app loads the SDK's native runtime at startup (KV-145).
 *
 * The lighter check for an Electron bump — launch the app, see the window —
 * is enough only because of this: `app/main/index.ts` statically imports
 * `./vitals`, which statically imports `@smartspectra/node-sdk`, whose import
 * loads the native runtime through koffi. So a window on screen proves the
 * load. Defer either import — which CLAUDE.md's "defer a load somewhere else"
 * could invite, for testing's sake — and the launch stops proving it while the
 * README still says it is enough. This fails first, so the rule is revisited
 * rather than silently weakened.
 *
 * Read from source rather than the built bundle, so it runs in the plain suite
 * with no build and no runtime. Importing the SDK here would load the runtime,
 * which is exactly what the suite must not need. Quote style is not asserted:
 * `index.ts` is the one file in `app/main` written with double quotes, and
 * normalising it must not read as a deferral (review of #146).
 */

const source = (path: string): string => readFileSync(path, 'utf8')

/** Escapes `text` for use inside a RegExp. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** A static `import { …name… } from 'specifier'`, in either quote style. */
const staticImport = (name: string, specifier: string): RegExp =>
  new RegExp(
    `^import \\{[^}]*\\b${literal(name)}\\b[^}]*\\} from ['"]${literal(specifier)}['"];?$`,
    'm',
  )

describe('the SDK is loaded when the app starts (KV-145)', () => {
  // Deferring either load means removing its static import, which these fail
  // on. A dynamic import elsewhere in the file does not undo a static one, so
  // it is not asserted against (review of #146).
  it('is imported statically by vitals.ts, from the package root', () => {
    expect(source('app/main/vitals.ts')).toMatch(
      staticImport('SmartSpectraSDK', '@smartspectra/node-sdk'),
    )
  })

  it('reaches the main entry point statically', () => {
    expect(source('app/main/index.ts')).toMatch(staticImport('captureVitals', './vitals'))
  })

  it('is read from the file the build actually starts from', () => {
    // Otherwise moving the entry to another file would leave the two tests
    // above reading a stale one, green, while the launch stopped proving the
    // load (review of #146). The first `lib.entry` in the config is main's.
    const config = source('electron.vite.config.ts')
    const [main] = [...config.matchAll(/lib: \{ entry: resolve\(__dirname, '([^']+)'\) \}/g)]
    expect(main?.[1]).toBe('app/main/index.ts')
  })
})
