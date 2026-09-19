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

/**
 * Every failure a throw can carry a tag for.
 *
 * A record rather than an array: `readonly CaptureFailure[]` accepts any
 * subset, so a member added to the union would be demanded by the two copy
 * tables on the screens and still be silently missing here — tagged correctly
 * at the throw, classified as `unknown` at the screen, with no compile error
 * anywhere to say so. A record makes that a type error in this file, beside
 * the type it belongs to.
 *
 * `unknown` is what classification falls back to, never something a throw
 * carries, so it is deliberately not a key here.
 */
const TAGGABLE: Record<Exclude<CaptureFailure, 'unknown'>, true> = {
  'no-api-key': true,
  'camera-unavailable': true,
  cancelled: true,
  'capture-in-progress': true,
  expired: true,
  'no-capture': true,
}

const TAGGED = Object.keys(TAGGABLE) as readonly Exclude<CaptureFailure, 'unknown'>[]

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
  // The *earliest* tag in the text wins, rather than the first in whatever
  // order the tags happen to be listed in. A message that quotes another
  // error can carry two, and the outer one — written by the code that decided
  // to throw — is the one that meant it. Order stops being load-bearing.
  let found: CaptureFailure = 'unknown'
  let at = Infinity
  for (const failure of TAGGED) {
    const index = text.indexOf(failureTag(failure))
    if (index !== -1 && index < at) {
      at = index
      found = failure
    }
  }
  return found
}
