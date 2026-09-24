import { failureTag } from './failure'
import type { CaptureResult } from '../session/types'

/**
 * What `checkin:capture` sends back over IPC, as opposed to what `capture`
 * hands the renderer (KV-89).
 *
 * A stopped capture used to *reject* across IPC, and Electron logs every
 * rejection from `ipcMain.handle` as "Error occurred in handler for …" with a
 * stack trace — so pressing Stop, the one thing the capture screen invites,
 * was recorded as a fault, printed directly under the `[capture] camera
 * release` line #86 added so a stuck camera would be visible.
 *
 * The rejection itself is needed: `classifyCaptureError` reads the
 * `cancelled` tag off it and leaves the screen. So cancellation crosses the
 * wire as a value and the preload turns it back into the same rejection. The
 * renderer sees exactly what it saw before; main's log sees nothing, because
 * nothing went wrong.
 *
 * **Cancellation only.** Every other capture failure is still a fault, and
 * still reaches the log as one. Widening this to "every failure becomes a
 * value" is the larger contract change #89 weighed, and would hide the faults
 * the log is for.
 */
export type CaptureReply =
  | { readonly kind: 'captured'; readonly result: CaptureResult }
  | { readonly kind: 'cancelled' }

/** The sentence a stopped capture rejects with, tag first, as `failure.ts` reads it. */
export const CANCELLED_MESSAGE = `${failureTag('cancelled')}: the reading was stopped.`

/**
 * Runs a capture for the wire: a cancellation resolves, anything else rejects
 * as before. `isCancelled` is passed in because the error class lives with the
 * capture in `app/main`, which `core/` does not import.
 */
export async function toCaptureReply(
  capture: () => Promise<CaptureResult>,
  isCancelled: (err: unknown) => boolean,
): Promise<CaptureReply> {
  try {
    return { kind: 'captured', result: await capture() }
  } catch (err) {
    if (isCancelled(err)) return { kind: 'cancelled' }
    throw err
  }
}

/**
 * Back to what the renderer expects: the result, or the tagged rejection it
 * classifies as `cancelled`. Anything that is not a reply this module wrote is
 * refused rather than guessed at.
 */
export function fromCaptureReply(reply: unknown): CaptureResult {
  if (typeof reply === 'object' && reply !== null && 'kind' in reply) {
    const r = reply as CaptureReply
    if (r.kind === 'captured' && 'result' in r) return r.result
    if (r.kind === 'cancelled') throw new Error(CANCELLED_MESSAGE)
  }
  throw new Error('checkin:capture sent back something that is not a capture reply.')
}
