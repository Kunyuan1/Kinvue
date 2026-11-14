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
 */

const source = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')

/** `boot.ts` as a syntax tree, and every call in it matching `is`. */
function callsIn(is: (call: ts.CallExpression, file: ts.SourceFile) => boolean): {
  file: ts.SourceFile
  calls: ts.CallExpression[]
} {
  const file = ts.createSourceFile('boot.ts', source('main/boot.ts'), ts.ScriptTarget.Latest, true)
  const calls: ts.CallExpression[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && is(node, file)) calls.push(node)
    ts.forEachChild(node, walk)
  }
  walk(file)
  return { file, calls }
}

const ancestors = (node: ts.Node): ts.Node[] => {
  const up: ts.Node[] = []
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) up.push(n)
  return up
}

describe('the single-instance lock (KV-222)', () => {
  const lock = callsIn((call, file) => call.expression.getText(file) === 'app.requestSingleInstanceLock')
  const load = callsIn(
    (call, file) =>
      call.expression.kind === ts.SyntaxKind.ImportKeyword &&
      call.arguments[0]?.getText(file).slice(1, -1) === './index',
  )

  it('is asked for once, at start, never inside something run later', () => {
    expect(lock.calls).toHaveLength(1)
    expect(ancestors(lock.calls[0] as ts.Node).some(ts.isFunctionLike)).toBe(false)
  })

  it('is asked for before the rest of main is loaded', () => {
    // `index` is where the store is made and the SDK's runtime loaded: a copy
    // that is not the only one must reach neither.
    expect(load.calls).toHaveLength(1)
    expect((lock.calls[0] as ts.Node).getStart()).toBeLessThan((load.calls[0] as ts.Node).getStart())
  })

  it('keeps a second copy from loading the rest of main at all', () => {
    // The load sits in a branch of the `if` that tests the lock's answer, and
    // not in the branch taken when it was refused. Held by the tree, not by
    // reading: an `import('./index')` moved above the check, or out of it,
    // would start a second store beside the first.
    const declaration = ancestors(lock.calls[0] as ts.Node).find(ts.isVariableDeclaration)
    const held = declaration?.name.getText(lock.file) ?? ''
    expect(held, 'the lock’s answer is not kept in a variable').not.toBe('')
    const guard = ancestors(load.calls[0] as ts.Node)
      .filter(ts.isIfStatement)
      .find((statement) => statement.expression.getText(load.file) === `!${held}`)
    expect(guard, `import('./index') is not under an \`if (!${held})\``).toBeDefined()
    const refused = guard?.thenStatement
    const loadAt = (load.calls[0] as ts.Node).getStart()
    expect(refused !== undefined && loadAt >= refused.getStart() && loadAt < refused.getEnd()).toBe(
      false,
    )
    // And the refused branch leaves.
    expect(refused?.getText(load.file)).toMatch(/app\.quit\(\)/)
  })

  it('has the running copy listen for the second start', () => {
    expect(source('main/index.ts')).toMatch(/app\.on\(\s*["']second-instance["']/)
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

describe('started again while running (KV-222)', () => {
  it('brings the window forward', () => {
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
