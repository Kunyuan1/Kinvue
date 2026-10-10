import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The app loads the SDK's native runtime at startup (KV-145).
 *
 * The lighter check for an Electron bump — launch the app, see the window —
 * is enough only because of this: `app/main/boot.ts` loads `./index` at start
 * (KV-19), `app/main/index.ts` statically imports `./vitals`, which statically
 * imports `@smartspectra/node-sdk`, whose import loads the native runtime
 * through koffi. So a window on screen proves the load. Defer either import — which CLAUDE.md's "defer a load somewhere else"
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

  it('is read from the files the build actually starts from', () => {
    // Otherwise moving the entry to another file would leave the tests here
    // reading a stale one, green, while the launch stopped proving the load
    // (review of #146). Since KV-19 the app starts at `boot`, which sets where
    // the runtime is and then loads `index`; both are main's entries.
    const config = source('electron.vite.config.ts')
    expect(config).toContain("boot: resolve(__dirname, 'app/main/boot.ts')")
    expect(config).toContain("index: resolve(__dirname, 'app/main/index.ts')")
    expect(JSON.parse(source('package.json')).main).toBe('./out/main/boot.js')
  })

  it('is loaded by boot at start, before any window, never on demand (KV-19)', () => {
    // `boot` reaches `index` by a dynamic import — the one way to run before the
    // SDK's hoisted require — at the top level, so it runs at start. Inside a
    // handler, it would load on demand, and a window would prove nothing. A
    // failure there is said in a dialog and the app exits: no window either way.
    const boot = ts.createSourceFile(
      'boot.ts',
      source('app/main/boot.ts'),
      ts.ScriptTarget.Latest,
      true,
    )
    const loads: ts.CallExpression[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0]?.getText(boot).slice(1, -1) === './index'
      ) {
        loads.push(node)
      }
      ts.forEachChild(node, walk)
    }
    walk(boot)
    expect(loads).toHaveLength(1)
    // Not inside any function: a handler, a callback, anything run later.
    let node: ts.Node | undefined = loads[0]
    while (node !== undefined) {
      expect(ts.isFunctionLike(node), 'import(./index) is inside a function').toBe(false)
      node = node.parent
    }
    expect(source('app/main/boot.ts')).toMatch(/app\.exit\(1\)/)
  })
})
