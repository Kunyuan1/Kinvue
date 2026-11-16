import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { bringForward, type WindowLike } from '../main/single-instance'

/**
 * One Kinvue for each history (KV-222). The store queues its writes within a
 * process and no further, so a second main process on the same `sessions.json`
 * — the shortcut pressed twice — could drop a check-in or rename a half-written
 * file into place. Nothing asked for the lock until this, and a comment in the
 * store said something did.
 *
 * `boot.ts` and `index.ts` import Electron, so what they do is read from their
 * syntax trees, as `sdk-load.test.ts` reads them — from the tree, never from
 * the text, where a line commented out still matches (review of #246).
 */

const source = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)

/** Every call in `file` matching `is`. */
function callsIn(file: ts.SourceFile, is: (call: ts.CallExpression) => boolean): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && is(node)) calls.push(node)
    ts.forEachChild(node, walk)
  }
  walk(file)
  return calls
}

const ancestors = (node: ts.Node): ts.Node[] => {
  const up: ts.Node[] = []
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) up.push(n)
  return up
}

/** Whether `node` is run as the file loads: inside no function, of any kind. */
const atTopLevel = (node: ts.Node): boolean => !ancestors(node).some(ts.isFunctionLike)

/** The one call a test is about, or a failure that says there was not exactly one. */
function only(calls: ts.CallExpression[], what: string): ts.CallExpression {
  expect(calls, what).toHaveLength(1)
  return calls[0] as ts.CallExpression
}

/** The modules `file` imports statically, which run before any line of its own. */
const staticImports = (file: ts.SourceFile): string[] =>
  file.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)

/** `app.on("<event>", listener)` calls in `file`. */
const listenersFor = (file: ts.SourceFile, event: string): ts.CallExpression[] =>
  callsIn(file, (call) => {
    const first = call.arguments[0]
    return (
      call.expression.getText(file) === 'app.on' &&
      first !== undefined &&
      ts.isStringLiteral(first) &&
      first.text === event
    )
  })

describe('the single-instance lock (KV-222)', () => {
  const boot = parse('main/boot.ts')
  const lockCalls = callsIn(
    boot,
    (call) => call.expression.getText(boot) === 'app.requestSingleInstanceLock',
  )
  const loadCalls = callsIn(
    boot,
    (call) =>
      call.expression.kind === ts.SyntaxKind.ImportKeyword &&
      call.arguments[0]?.getText(boot).slice(1, -1) === './index',
  )

  it('is asked for once, at start, never inside something run later', () => {
    expect(atTopLevel(only(lockCalls, 'calls to requestSingleInstanceLock'))).toBe(true)
  })

  it('is asked for before the rest of main is loaded', () => {
    // `index` is where the store is made and the SDK's runtime loaded: a copy
    // that is not the only one must reach neither.
    const lock = only(lockCalls, 'calls to requestSingleInstanceLock')
    const load = only(loadCalls, "import('./index') calls")
    expect(lock.getStart()).toBeLessThan(load.getStart())
  })

  it('lets nothing else in ahead of it by a static import (review of #246)', () => {
    // A static import is hoisted above every line of `boot.ts`, the lock
    // included, and the tests here watch only the one dynamic import: an
    // `import … from './api-key'` added to `boot.ts` would open that file in a
    // copy about to be refused, with all of them green. So the imports are a
    // list. Adding to it is a decision: the module, and everything it imports
    // in turn, runs in the second copy too.
    expect(staticImports(boot).sort()).toEqual(['./app-protocol', './runtime-path', 'electron'])
    // And those two reach nothing of the app's: Node's own modules only.
    for (const path of ['main/app-protocol.ts', 'main/runtime-path.ts']) {
      const reached = staticImports(parse(path)).filter((name) => !name.startsWith('node:'))
      expect(reached, `${path} imports`).toEqual([])
    }
  })

  /** The `if` that tests the lock's answer, and the branch taken when it was refused. */
  const refusal = (): { guard: ts.IfStatement; refused: ts.Statement } => {
    const lock = only(lockCalls, 'calls to requestSingleInstanceLock')
    const held = ancestors(lock).find(ts.isVariableDeclaration)?.name.getText(boot) ?? ''
    expect(held, 'the lock’s answer is not kept in a variable').not.toBe('')
    const guard = boot.statements
      .filter(ts.isIfStatement)
      .find((statement) => statement.expression.getText(boot) === `!${held}`)
    expect(guard, `no top-level \`if (!${held})\``).toBeDefined()
    return { guard: guard as ts.IfStatement, refused: (guard as ts.IfStatement).thenStatement }
  }

  const within = (node: ts.Node, outer: ts.Node | undefined): boolean =>
    outer !== undefined && node.getStart() >= outer.getStart() && node.getEnd() <= outer.getEnd()

  it('keeps a second copy from loading the rest of main at all', () => {
    // The load sits in the `else` of the `if` that tests the lock's answer.
    // Held by the tree, not by reading: an `import('./index')` moved above the
    // check, or out of it, would start a second store beside the first.
    const { guard, refused } = refusal()
    const load = only(loadCalls, "import('./index') calls")
    expect(within(load, guard.elseStatement), "import('./index') is outside the else").toBe(true)
    expect(within(load, refused)).toBe(false)
  })

  it('keeps a second copy from the SDK’s runtime path too', () => {
    // `runtimeProblem()` sets where the SDK's runtime is and can raise a dialog:
    // nothing a copy that is leaving should do (review of #246).
    const { guard, refused } = refusal()
    const call = only(
      callsIn(boot, (c) => c.expression.getText(boot) === 'runtimeProblem'),
      'calls to runtimeProblem',
    )
    expect(within(call, guard.elseStatement)).toBe(true)
    expect(within(call, refused)).toBe(false)
  })

  it('has the refused copy say why, and leave', () => {
    // Said, because with the installed app open `npm run dev` is the second
    // copy, and silence there was an empty terminal and no window (review of
    // #246). Both calls in the branch itself, not text somewhere near it.
    const { refused } = refusal()
    const inRefused = (name: string): ts.CallExpression[] =>
      callsIn(boot, (c) => c.expression.getText(boot) === name && within(c, refused))
    expect(inRefused('app.quit'), 'app.quit() in the refused branch').toHaveLength(1)
    const said = only(inRefused('console.info'), 'console.info in the refused branch')
    expect(said.arguments[0]?.getText(boot)).toMatch(/already running/)
    expect(said.arguments[0]?.getText(boot)).toMatch(/--user-data-dir/)
  })
})

describe('the running copy, started again (KV-222)', () => {
  const index = parse('main/index.ts')

  it('listens from the moment main loads, not once a window is up (review of #246)', () => {
    // The lock is held from `boot.ts` on. Listened for only at the end of
    // start-up, a start that stopped partway held the lock with nobody
    // listening, and every later start left at once: no way back in.
    const listener = only(listenersFor(index, 'second-instance'), 'second-instance listeners')
    expect(atTopLevel(listener), 'the listener is registered inside a function').toBe(true)
  })

  it('answers by bringing the window forward', () => {
    // Its body, not its presence: a listener that did nothing would also be one.
    const listener = only(listenersFor(index, 'second-instance'), 'second-instance listeners')
    const handler = listener.arguments[1]
    expect(handler !== undefined && ts.isFunctionLike(handler)).toBe(true)
    const brought = callsIn(
      index,
      (c) =>
        c.expression.getText(index) === 'bringForward' &&
        handler !== undefined &&
        c.getStart() >= handler.getStart() &&
        c.getEnd() <= handler.getEnd(),
    )
    expect(brought, 'bringForward calls in the listener').toHaveLength(1)
  })

  it('opens a window from there only once start-up has made the first', () => {
    // Before that one is on its way: a second made here would be two windows
    // on one start. The flag is set straight after start-up's `createWindow()`.
    const listener = only(listenersFor(index, 'second-instance'), 'second-instance listeners')
    const opens = callsIn(
      index,
      (c) =>
        c.expression.getText(index) === 'createWindow' &&
        c.getStart() >= listener.getStart() &&
        c.getEnd() <= listener.getEnd(),
    )
    const open = only(opens, 'createWindow calls in the listener')
    const guard = ancestors(open).find(ts.isIfStatement)
    expect(guard?.expression.getText(index)).toBe('started')
    expect(source('main/index.ts')).toMatch(/createWindow\(\);\s*\n\s*started = true;/)
  })

  it('does not stay, holding the lock, when start-up fails (review of #246)', () => {
    // A rejection nobody handled left a process with no window that never quit
    // — and, holding the lock, one that turned every later start away. So the
    // chain that starts the app ends in a catch that says so and exits.
    const ready = only(
      callsIn(index, (c) => c.expression.getText(index) === 'app.whenReady'),
      'app.whenReady() calls',
    )
    // app.whenReady() → .then(...) → .catch(...): the outermost call of the chain.
    const chain = ancestors(ready).filter(ts.isCallExpression)
    const outer = chain.at(-1)
    expect(outer?.expression.getText(index).endsWith('.catch')).toBe(true)
    const handler = outer?.arguments[0]
    const inHandler = (name: string): number =>
      callsIn(
        index,
        (c) =>
          c.expression.getText(index) === name &&
          handler !== undefined &&
          c.getStart() >= handler.getStart() &&
          c.getEnd() <= handler.getEnd(),
      ).length
    expect(inHandler('dialog.showErrorBox'), 'the failure is said').toBe(1)
    expect(inHandler('app.exit'), 'the app leaves').toBe(1)
    expect(atTopLevel(ready)).toBe(true)
  })
})

function fakeWindow(state: Partial<{ destroyed: boolean; minimized: boolean; visible: boolean }> = {}) {
  const did: string[] = []
  const window: WindowLike & { did: string[] } = {
    did,
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    isVisible: () => state.visible !== false,
    restore: () => did.push('restore'),
    focus: () => did.push('focus'),
  }
  return window
}

describe('bringing the window forward (KV-222)', () => {
  it('focuses it', () => {
    const window = fakeWindow()
    let opened = 0
    bringForward([window], () => opened++)
    expect(window.did).toEqual(['focus'])
    expect(opened).toBe(0)
  })

  it('restores a minimised window first', () => {
    const window = fakeWindow({ minimized: true })
    bringForward([window], () => undefined)
    expect(window.did).toEqual(['restore', 'focus'])
  })

  it('leaves a window not yet shown to be shown when its page has drawn (KV-139)', () => {
    // The usual second start: the shortcut pressed again while the first is
    // still opening. Shown from here, it would be a blank window.
    const window = fakeWindow({ visible: false })
    let opened = 0
    bringForward([window], () => opened++)
    expect(window.did).toEqual([])
    expect(opened).toBe(0)
  })

  it('opens a window when none is left, and passes over one already gone', () => {
    let opened = 0
    bringForward([], () => opened++)
    expect(opened).toBe(1)
    const gone = fakeWindow({ destroyed: true })
    const here = fakeWindow()
    bringForward([gone, here], () => opened++)
    expect(gone.did).toEqual([])
    expect(here.did).toEqual(['focus'])
    expect(opened).toBe(1)
  })
})
