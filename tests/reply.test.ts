import { describe, expect, it } from 'vitest'
import { classifyCaptureError } from '@core/capture/failure'
import { fromCaptureReply, toCaptureReply, type CaptureReply } from '@core/capture/reply'
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
const isCancelled = (err: unknown): boolean => err instanceof CaptureCancelledError

/** What the renderer would receive: the wire reply, decoded by the preload. */
const overTheWire = async (capture: () => Promise<CaptureResult>): Promise<CaptureResult> => {
  // A structured-clone round trip, as IPC does, so nothing rides on identity.
  const reply = structuredClone(await toCaptureReply(capture, isCancelled))
  return fromCaptureReply(reply)
}

describe('the capture reply (KV-89)', () => {
  it('resolves, rather than rejecting, when the person stopped the capture', async () => {
    const reply = await toCaptureReply(() => Promise.reject(new CaptureCancelledError()), isCancelled)
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
    await expect(toCaptureReply(() => Promise.reject(fault), isCancelled)).rejects.toBe(fault)
  })

  it('does not treat an error that merely quotes the stop sentence as a stop', async () => {
    // Decided by the class main threw, not by reading text.
    const lookalike = new Error(new CaptureCancelledError().message)
    await expect(toCaptureReply(() => Promise.reject(lookalike), isCancelled)).rejects.toBe(
      lookalike,
    )
  })

  it('refuses a reply it did not write rather than guessing', () => {
    for (const odd of [undefined, null, 'cancelled', { kind: 'other' }, { kind: 'captured' }]) {
      expect(() => fromCaptureReply(odd as CaptureReply)).toThrow(/not a capture reply/)
    }
  })

  it('rejects with the very sentence the capture error carries', () => {
    expect(() => fromCaptureReply({ kind: 'cancelled' })).toThrow(new CaptureCancelledError().message)
  })
})
