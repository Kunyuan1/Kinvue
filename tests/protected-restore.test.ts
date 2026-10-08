import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { protectedRestores } from '../app/main/protected-restore'
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
    waiting.hold(new EventEmitter(), 'p', file)
    const done = waiting.unlock('p', 'right one', restore)
    await settleNext()
    expect(await done).toEqual(RESTORED)
    expect(restore).toHaveBeenCalledWith({ records: [] })
    expect(waiting.holding()).toBe(false)
  })

  it('keeps the file for another try after a wrong passphrase', async () => {
    const { open, settleNext } = gate()
    const waiting = protectedRestores(open)
    waiting.hold(new EventEmitter(), 'p', file)
    const done = waiting.unlock('p', 'wrong one', async () => RESTORED)
    await settleNext()
    expect(await done).toEqual({ ok: false, refusal: { kind: 'wrong-passphrase' } })
    expect(waiting.holding()).toBe(true)
  })

  it('runs tries one at a time, and one queued behind a restore finds nothing', async () => {
    const { open, settleNext, most } = gate()
    const waiting = protectedRestores(open)
    waiting.hold(new EventEmitter(), 'p', file)
    const first = waiting.unlock('p', 'right one', async () => RESTORED)
    const second = waiting.unlock('p', 'right one', async () => RESTORED)
    const third = waiting.unlock('p', 'right one', async () => RESTORED)
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
    waiting.hold(new EventEmitter(), 'p', file)
    const done = waiting.unlock('p', 'right one', restore)
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
      waiting.hold(page, 'p', file)
      expect(page.listenerCount(event)).toBe(1)
      page.emit(event)
      expect(waiting.holding()).toBe(false)
      expect(page.listenerCount('did-navigate') + page.listenerCount('destroyed')).toBe(0)
    }
  })

  it('leaves no listeners behind on a page that restores many times', () => {
    const waiting = protectedRestores(gate().open)
    const page = new EventEmitter()
    for (let i = 0; i < 20; i++) waiting.hold(page, 'p', file)
    expect(page.listenerCount('did-navigate')).toBe(1)
    waiting.letGo()
    expect(page.listenerCount('did-navigate') + page.listenerCount('destroyed')).toBe(0)
  })

  it('will not open a file held for another person', async () => {
    const waiting = protectedRestores(gate().open)
    waiting.hold(new EventEmitter(), 'p', file)
    await expect(waiting.unlock('q', 'right one', async () => RESTORED)).rejects.toThrow(
      /no protected file waiting/,
    )
  })
})
