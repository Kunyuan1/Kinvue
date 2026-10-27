import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { protectedRestores, unconfirmedRestores } from '../app/main/protected-restore'
import type { RestoreResult } from '@core/session/lifecycle'
import type { ProtectedExport, Unprotected } from '@core/session/protect'

/**
 * A protected export held in main for its passphrase (KV-175, review of #187):
 * tries one at a time, a Cancel that holds while scrypt runs, and nothing held
 * past the page that asked for it. A stand-in for `unprotect`, so no scrypt
 * runs, and an `EventEmitter` for the page.
 */

const file = { kind: 'kinvue-history', version: 2 } as unknown as ProtectedExport
const RESTORED: RestoreResult = {
  ok: true,
  outcome: { restored: 1, alreadyHere: 0, stayDeleted: 0, deletedAt: [], deletedThere: 0 },
  into: { personId: 'p', added: null },
}

/** An `open` the test settles by hand, recording how many run at once. */
function gate() {
  const pending: ((u: Unprotected) => void)[] = []
  let running = 0
  let most = 0
  const open = (_f: ProtectedExport, passphrase: string): Promise<Unprotected> => {
    running++
    most = Math.max(most, running)
    return new Promise((resolve) =>
      pending.push((u) => {
        running--
        resolve(passphrase === 'right one' ? u : { ok: false, why: 'wrong-passphrase' })
      }),
    )
  }
  const settleNext = async (): Promise<void> => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    pending.shift()!({ ok: true, contents: { records: [] } })
  }
  return { open, settleNext, most: () => most, started: () => pending.length }
}

describe('protectedRestores', () => {
  it('opens the held file, restores it, and lets go', async () => {
    const { open, settleNext } = gate()
    const waiting = protectedRestores(open)
    const restore = vi.fn(async () => RESTORED)
    waiting.hold(new EventEmitter(), file)
    const done = waiting.unlock('right one', restore)
    await settleNext()
    expect(await done).toEqual(RESTORED)
    expect(restore).toHaveBeenCalledWith({ records: [] })
    expect(waiting.holding()).toBe(false)
  })

  it('keeps the file for another try after a wrong passphrase', async () => {
    const { open, settleNext } = gate()
    const waiting = protectedRestores(open)
    waiting.hold(new EventEmitter(), file)
    const done = waiting.unlock('wrong one', async () => RESTORED)
    await settleNext()
    expect(await done).toEqual({ ok: false, refusal: { kind: 'wrong-passphrase' } })
    expect(waiting.holding()).toBe(true)
  })

  it('runs tries one at a time, and one queued behind a restore finds nothing', async () => {
    const { open, settleNext, most } = gate()
    const waiting = protectedRestores(open)
    waiting.hold(new EventEmitter(), file)
    const first = waiting.unlock('right one', async () => RESTORED)
    const second = waiting.unlock('right one', async () => RESTORED)
    const third = waiting.unlock('right one', async () => RESTORED)
    await settleNext()
    expect(await first).toEqual(RESTORED)
    await expect(second).rejects.toThrow(/no protected file waiting/)
    await expect(third).rejects.toThrow(/no protected file waiting/)
    expect(most()).toBe(1)
  })

  it('restores nothing once a Cancel lands while the passphrase is checked', async () => {
    const { open, settleNext, started } = gate()
    const waiting = protectedRestores(open)
    const restore = vi.fn(async () => RESTORED)
    waiting.hold(new EventEmitter(), file)
    const done = waiting.unlock('right one', restore)
    // Cancel once the passphrase is being checked, not before.
    await vi.waitFor(() => expect(started()).toBe(1))
    waiting.letGo()
    await settleNext()
    await expect(done).rejects.toThrow(/cancelled/)
    expect(restore).not.toHaveBeenCalled()
  })

  it('lets go when the page navigates or is destroyed, and stops listening then', async () => {
    const waiting = protectedRestores(gate().open)
    for (const event of ['did-navigate', 'destroyed'] as const) {
      const page = new EventEmitter()
      waiting.hold(page, file)
      expect(page.listenerCount(event)).toBe(1)
      page.emit(event)
      expect(waiting.holding()).toBe(false)
      expect(page.listenerCount('did-navigate') + page.listenerCount('destroyed')).toBe(0)
    }
  })

  it('leaves no listeners behind on a page that restores many times', () => {
    const waiting = protectedRestores(gate().open)
    const page = new EventEmitter()
    for (let i = 0; i < 20; i++) waiting.hold(page, file)
    expect(page.listenerCount('did-navigate')).toBe(1)
    waiting.letGo()
    expect(page.listenerCount('did-navigate') + page.listenerCount('destroyed')).toBe(0)
  })

  it('will not open a file once it has been let go', async () => {
    // Whose a file is, the file says once opened (KV-18): no person is held
    // with it any more, so the guard left is that something is held at all.
    const waiting = protectedRestores(gate().open)
    waiting.hold(new EventEmitter(), file)
    waiting.letGo()
    await expect(waiting.unlock('right one', async () => RESTORED)).rejects.toThrow(
      /no protected file waiting/,
    )
  })
})

describe('an export from before keys, held for its question (KV-18, review of #207)', () => {
  const contents = { kind: 'kinvue-history', version: 1, personId: 'demo-margaret' }

  it('restores what it holds, for the page that asked, and lets go', async () => {
    const asked = unconfirmedRestores()
    const page = new EventEmitter()
    asked.hold(page, contents)
    const restore = vi.fn(async () => RESTORED)
    expect(await asked.confirm(page, restore)).toBe(RESTORED)
    expect(restore).toHaveBeenCalledWith(contents)
    expect(asked.holding()).toBe(false)
    expect(page.listenerCount('did-navigate') + page.listenerCount('destroyed')).toBe(0)
  })

  it('answers no other page', async () => {
    const asked = unconfirmedRestores()
    asked.hold(new EventEmitter(), contents)
    const restore = vi.fn(async () => RESTORED)
    await expect(asked.confirm(new EventEmitter(), restore)).rejects.toThrow(/nothing waiting/)
    expect(restore).not.toHaveBeenCalled()
  })

  it('lets go when its page navigates or is destroyed: a protected one is held opened', async () => {
    const asked = unconfirmedRestores()
    for (const event of ['did-navigate', 'destroyed'] as const) {
      const page = new EventEmitter()
      asked.hold(page, contents)
      page.emit(event)
      expect(asked.holding()).toBe(false)
      expect(page.listenerCount('did-navigate') + page.listenerCount('destroyed')).toBe(0)
      await expect(asked.confirm(page, async () => RESTORED)).rejects.toThrow(/nothing waiting/)
    }
  })

  it('holds one at a time, and leaves no listeners behind', () => {
    const asked = unconfirmedRestores()
    const page = new EventEmitter()
    for (let i = 0; i < 20; i++) asked.hold(page, contents)
    expect(page.listenerCount('did-navigate')).toBe(1)
    asked.letGo()
    expect(page.listenerCount('did-navigate') + page.listenerCount('destroyed')).toBe(0)
  })
})
