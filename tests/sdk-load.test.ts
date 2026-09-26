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
 * which is exactly what the suite must not need.
 */

const source = (path: string): string => readFileSync(path, 'utf8')

describe('the SDK is loaded when the app starts (KV-145)', () => {
  it('is imported statically by vitals.ts, from the package root', () => {
    const vitals = source('app/main/vitals.ts')
    expect(vitals).toMatch(/^import \{[^}]*SmartSpectraSDK[^}]*\} from '@smartspectra\/node-sdk'$/m)
    expect(vitals).not.toMatch(/\bimport\(|\brequire\(/)
  })

  it('reaches the main entry point statically', () => {
    const index = source('app/main/index.ts')
    expect(index).toMatch(/^import \{[^}]*\bcaptureVitals\b[^}]*\} from "\.\/vitals";$/m)
    expect(index).not.toMatch(/\bimport\(|\brequire\(/)
  })
})
