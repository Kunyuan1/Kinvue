import { describe, expect, it } from 'vitest'
import { createInFlightCapture } from '../app/main/in-flight'

/**
 * The person in front of the camera decides when being filmed stops (KV-3), so
 * the slot that makes stopping possible has to survive a refused capture.
 */
describe('createInFlightCapture', () => {
  it('aborts nothing when nothing is running', () => {
    const inFlight = createInFlightCapture()
    expect(inFlight.running).toBe(false)
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
    expect(inFlight.running).toBe(true)
  })

  it('releases the slot when the capture that owns it finishes', () => {
    const inFlight = createInFlightCapture()
    const running = new AbortController()
    inFlight.claim(running)

    inFlight.release(running)

    expect(inFlight.running).toBe(false)
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
