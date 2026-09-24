import { describe, expect, it } from 'vitest'
import { classifyCaptureError } from '@core/capture/failure'
import {
  CaptureCancelledError as SharedCancelled,
  fromCaptureReply,
  toCaptureReply,
  type CaptureReply,
} from '../app/shared/capture-reply'
import { CaptureCancelledError, MissingApiKeyError } from '../app/main/capture-errors'
import type { CaptureResult } from '@core/session/types'

/**
 * Pressing Stop used to reject across IPC, which Electron logs as a handler
 * fault with a stack trace (KV-89). A stop now crosses as a value; these pin
 * that the renderer still receives the rejection it classifies as a stop, and
 * that nothing else is quietened on the way.
 */

const result: CaptureResult = {
  captureId: 'c1',
  vitals: {
    pulseRateBpm: 70,
    breathingRateBrpm: 14,
    hrvRmssdMs: null,
    hrvSdnnMs: null,
    confidence: 0.9,
    stable: true,
    durationSec: 60,
  },
}
/** What the renderer would receive: the wire reply, decoded by the preload. */
const overTheWire = async (capture: () => Promise<CaptureResult>): Promise<CaptureResult> => {
  // A structured-clone round trip, as IPC does, so nothing rides on identity.
  const reply = structuredClone(await toCaptureReply(capture()))
  return fromCaptureReply(reply)
}

describe('the capture reply (KV-89)', () => {
  it('resolves, rather than rejecting, when the person stopped the capture', async () => {
    const reply = await toCaptureReply(Promise.reject(new CaptureCancelledError()))
    expect(reply).toEqual({ kind: 'cancelled' })
  })

  it('still reaches the renderer as a stop, which leaves the screen saying nothing', async () => {
    const err = await overTheWire(() => Promise.reject(new CaptureCancelledError())).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    // Null is how the capture screen reads a stop (see App.tsx).
    expect(classifyCaptureError(err)).toBeNull()
  })

  it('carries a finished capture through unchanged', async () => {
    await expect(overTheWire(() => Promise.resolve(result))).resolves.toEqual(result)
  })

  it('lets every other failure reject as before, so the log still sees faults', async () => {
    const fault = new MissingApiKeyError()
    await expect(toCaptureReply(Promise.reject(fault))).rejects.toBe(fault)
  })

  it('does not treat an error that merely quotes the stop sentence as a stop', async () => {
    // Decided by the class main threw, not by reading text.
    const lookalike = new Error(new CaptureCancelledError().message)
    await expect(toCaptureReply(Promise.reject(lookalike))).rejects.toBe(lookalike)
  })

  it('refuses a reply that is not the shape the screen goes on to read', () => {
    // Presence of `result` is not enough (KV-89 review): `result: null` used
    // to pass and fail later, inside the screen, as a TypeError.
    for (const odd of [
      undefined,
      null,
      'cancelled',
      { kind: 'other' },
      { kind: 'captured' },
      { kind: 'captured', result: null },
      { kind: 'captured', result: { vitals: result.vitals } },
      { kind: 'captured', result: { captureId: 'c1' } },
      { kind: 'captured', result: { captureId: 'c1', vitals: null } },
    ]) {
      expect(() => fromCaptureReply(odd as CaptureReply)).toThrow(/not a capture reply/)
    }
  })

  it('has one stop error, whichever file it is imported from', () => {
    // capture-errors re-exports it; two classes would let a stop slip past
    // the `instanceof` and be logged as a fault again.
    expect(CaptureCancelledError).toBe(SharedCancelled)
  })

  it('rejects with the very sentence the capture error carries', () => {
    expect(() => fromCaptureReply({ kind: 'cancelled' })).toThrow(new CaptureCancelledError().message)
  })
})
