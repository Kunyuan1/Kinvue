/**
 * Telling apart the ways a check-in can fail to happen.
 *
 * Three quite different situations used to reach the screen as the same raw
 * JavaScript error string: no API key configured, a camera another application
 * is holding, and a capture that ran and produced nothing usable. The first two
 * are setup and hardware; only the third is a fact about the person's day.
 *
 * Errors cross IPC as a message and nothing else — the class and any properties
 * are lost on the way — so the code is carried *in* the message, as a prefix.
 * That is what makes this classification stable when the wording changes, and
 * it is why the prefixes are never shown to anyone.
 */

export type CaptureFailure =
  /** No SmartSpectra key. A setup problem, and not about the person at all. */
  | 'no-api-key'
  /** The camera could not be opened, or the SDK gave up on it. */
  | 'camera-unavailable'
  /** The person stopped it. Not a failure to report as one. */
  | 'cancelled'
  /** A capture is already running, so another cannot start. */
  | 'capture-in-progress'
  /** The reading waited too long for its answers and is no longer offered. */
  | 'expired'
  /** The reading is gone: already submitted, replaced, or never existed. */
  | 'no-capture'
  /** Anything unclassified. Shown as a short line, never as a stack trace. */
  | 'unknown'

/** The prefix a thrown message carries, e.g. `kinvue/expired: …`. */
export const failureTag = (failure: CaptureFailure): string => `kinvue/${failure}`

const TAGGED: readonly CaptureFailure[] = [
  'no-api-key',
  'camera-unavailable',
  'cancelled',
  'capture-in-progress',
  'expired',
  'no-capture',
]

/**
 * What went wrong, from whatever the IPC layer handed back.
 *
 * Electron wraps a rejection as "Error invoking remote method 'checkin:capture':
 * Error: …", so the tag is looked for anywhere in the text rather than at the
 * start of it.
 */
export function classifyCaptureError(error: unknown): CaptureFailure {
  // `String` rather than reading `.message`: an Error stringifies to
  // "Error: <message>", which still contains the tag, and this way a rejection
  // that is not an Error at all is handled by the same line.
  const text = String(error)
  return TAGGED.find((failure) => text.includes(failureTag(failure))) ?? 'unknown'
}
