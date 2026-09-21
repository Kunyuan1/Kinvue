import { describe, expect, it } from 'vitest'
import { createInFlightCapture } from '../app/main/in-flight'

/**
 * The person in front of the camera decides when being filmed stops (KV-3), so
 * the slot that makes stopping possible has to survive a refused capture.
 */
describe('createInFlightCapture', () => {
  it('aborts nothing when nothing is running', () => {
    const inFlight = createInFlightCapture()
    expect(() => inFlight.abort()).not.toThrow()
  })

  it('aborts the capture that claimed it', () => {
    const inFlight = createInFlightCapture()
    const running = new AbortController()
    inFlight.claim(running)

    inFlight.abort()

    expect(running.signal.aborted).toBe(true)
  })

  it('keeps the running capture abortable when a second one is refused', () => {
    // The bug KV-76 is about. `index.ts` claimed the slot before asking
    // `checkIn.capture`, which refuses a second capture while one is running,
    // so the refused capture took the slot from the capture that refused it.
    const inFlight = createInFlightCapture()
    const running = new AbortController()
    const refused = new AbortController()
    inFlight.claim(running)

    // The refused capture never starts, so it never claims — and its cleanup
    // must not release a slot that was never its own.
    inFlight.release(refused)
    inFlight.abort()

    expect(running.signal.aborted).toBe(true)
    expect(refused.signal.aborted).toBe(false)
  })

  it('does not let a second claim take the slot from the capture running', () => {
    // The invariant KV-76 exists to establish, pinned in the module rather
    // than in where `index.ts` happens to call it. `index.ts` imports Electron
    // and cannot be tested, so while this rule lived only in the placement of
    // that call, moving the call back above the lock reinstated the bug in
    // full with all 212 tests green.
    const inFlight = createInFlightCapture()
    const running = new AbortController()
    const tooEarly = new AbortController()
    inFlight.claim(running)

    inFlight.claim(tooEarly)
    inFlight.abort()

    expect(running.signal.aborted).toBe(true)
    expect(tooEarly.signal.aborted).toBe(false)
  })

  it('leaves nothing claimed after an abort', () => {
    // Otherwise the slot points at a dead controller until the owner releases
    // it, and that release lives in the untested module. A capture path that
    // swallowed an abort would make every later abort a silent no-op — the
    // KV-76 symptom from the other end.
    const inFlight = createInFlightCapture()
    const first = new AbortController()
    const next = new AbortController()
    inFlight.claim(first)

    inFlight.abort()
    // The slot is free, so the next capture can take it without waiting for
    // the aborted one's cleanup to run.
    inFlight.claim(next)
    inFlight.abort()

    expect(next.signal.aborted).toBe(true)
  })

  it('ignores a release from the capture that never owned the slot', () => {
    // A refused capture runs the same `finally` as a successful one.
    const inFlight = createInFlightCapture()
    const running = new AbortController()
    const refused = new AbortController()
    inFlight.claim(running)

    inFlight.release(refused)
    inFlight.abort()

    expect(running.signal.aborted).toBe(true)
  })

  it('releases the slot when the capture that owns it finishes', () => {
    const inFlight = createInFlightCapture()
    const running = new AbortController()
    inFlight.claim(running)

    inFlight.release(running)

    // Asserted through what the slot does, not by inspecting it: nothing owns
    // it, so an abort reaches nobody.
    inFlight.abort()
    expect(running.signal.aborted).toBe(false)
  })

  it('lets the next capture claim the slot after the last released it', () => {
    const inFlight = createInFlightCapture()
    const first = new AbortController()
    const second = new AbortController()

    inFlight.claim(first)
    inFlight.release(first)
    inFlight.claim(second)
    inFlight.abort()

    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(true)
  })
})
