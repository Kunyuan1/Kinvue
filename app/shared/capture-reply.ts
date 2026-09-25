import { failureTag } from '@core/capture/failure'
import type { CaptureResult } from '@core/session/types'

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
 * wire as a value and the preload turns it back into a rejection carrying the
 * same tag, which the screen classifies exactly as before. Main's log sees
 * nothing, because nothing went wrong.
 *
 * **Cancellation only.** Every other capture failure is still a fault, and
 * still reaches the log as one. Widening this to "every failure becomes a
 * value" is the larger contract change #89 weighed, and would hide the faults
 * the log is for.
 *
 * **Not in `core/`, on purpose.** This exists because of how Electron logs a
 * handler, which is an Electron concern, not a domain one; the caregiver
 * client and sync service `core/` is meant for (#38) have no `ipcMain`. It is
 * shared by main and the preload, which is why it sits in neither, and it
 * imports no Electron and no SDK so the plain suite can test it.
 */
export type CaptureReply =
  | { readonly kind: 'captured'; readonly result: CaptureResult }
  | { readonly kind: 'cancelled' }

/** The sentence a stopped capture rejects with, tag first, as `failure.ts` reads it. */
export const CANCELLED_MESSAGE = `${failureTag('cancelled')}: the reading was stopped.`

/**
 * Thrown when the person stopped the capture. Not a failure to report as one:
 * `toCaptureReply` turns it into a reply rather than letting it reach
 * Electron's handler log, and the preload rethrows the same sentence.
 *
 * Lives with the message it carries, so what counts as a stop is decided in
 * one file. `app/main/capture-errors.ts` re-exports it beside the others.
 */
export class CaptureCancelledError extends Error {
  constructor() {
    super(CANCELLED_MESSAGE)
    this.name = 'CaptureCancelledError'
  }
}

/**
 * A running capture, made ready for the wire: a stop resolves, anything else
 * rejects as before.
 *
 * Decided by the class main threw, never by reading text, so an unrelated
 * error that happens to quote the stop sentence is still logged as a fault.
 */
export async function toCaptureReply(capture: Promise<CaptureResult>): Promise<CaptureReply> {
  try {
    return { kind: 'captured', result: await capture }
  } catch (err) {
    if (err instanceof CaptureCancelledError) return { kind: 'cancelled' }
    throw err
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/**
 * Whether this is the shape the renderer goes on to read: an id to submit and
 * vitals to show. The vitals themselves were checked where they were made;
 * this only refuses to hand the screen something it would fall over on.
 */
const isCaptureResult = (v: unknown): v is CaptureResult =>
  isObject(v) && typeof v.captureId === 'string' && isObject(v.vitals)

/**
 * Back to what the renderer expects: the result, or the tagged rejection it
 * classifies as `cancelled`. Anything that is not a reply of that shape is
 * refused rather than handed on.
 *
 * The refusal is untagged, so the capture screen shows it as `unknown`, which
 * since KV-80 names no cause and advises no retry — true of a reply main did
 * not write. Main cannot send one; this is the floor, not a path.
 */
export function fromCaptureReply(reply: unknown): CaptureResult {
  if (isObject(reply)) {
    if (reply.kind === 'captured' && isCaptureResult(reply.result)) return reply.result
    if (reply.kind === 'cancelled') throw new Error(CANCELLED_MESSAGE)
  }
  throw new Error('checkin:capture sent back something that is not a capture reply.')
}
