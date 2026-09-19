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
 *
 * **Two unions, not one (KV-75).** A failure belongs to a path. Nothing in the
 * capture path can expire, and nothing in the submit path can find the camera
 * busy — so one flat union meant each screen's copy table was exhaustive over
 * a set half of which could not reach it. That reads as "every failure is
 * handled" while most of the entries are dead, which is the same
 * reassuring-and-wrong signal KV-7 set out to remove. Each path now has its own
 * union, and `unknown` is in both because either can fail in a way nothing
 * tagged.
 */

/**
 * Every failure a throw can carry a tag for, before any screen sees it.
 *
 * This is the wire, not a thing to render: a screen that took this would be
 * back to a table half of which is unreachable. Screens take `CaptureFailure`
 * or `SubmitFailure`.
 */
export type TaggedFailure =
  /** No SmartSpectra key, or one the service rejects. Setup, not the person. */
  | 'no-api-key'
  /** The camera could not be opened, or the SDK gave up on it. */
  | 'camera-unavailable'
  /** A capture is already running, so another cannot start. */
  | 'capture-in-progress'
  /** The person stopped it. Not a failure to report as one. */
  | 'cancelled'
  /** The reading waited too long for its answers and is no longer offered. */
  | 'expired'
  /** The reading is gone: already submitted, replaced, or never existed. */
  | 'no-capture'

/**
 * What the capture screen can be asked to say.
 *
 * `cancelled` is deliberately absent. The person stopped it themselves, so
 * there is nothing to tell them — `classifyCaptureError` returns null for it
 * rather than a sentence nobody should read.
 */
export type CaptureFailure =
  | 'no-api-key'
  | 'camera-unavailable'
  | 'capture-in-progress'
  /** Anything unclassified. Shown as a short line, never as a stack trace. */
  | 'unknown'

/** What the questions screen can be asked to say when answers cannot be stored. */
export type SubmitFailure =
  | 'expired'
  | 'no-capture'
  /** Anything unclassified. The store and the scorer carry no tag. */
  | 'unknown'

/** The prefix a thrown message carries, e.g. `kinvue/expired: …`. */
export const failureTag = (failure: TaggedFailure): string => `kinvue/${failure}`

/**
 * Every failure a throw can carry a tag for.
 *
 * A record rather than an array: `readonly TaggedFailure[]` accepts any subset,
 * so a member added to the union could be tagged correctly at the throw and
 * still be missing here — classified as `unknown` at the screen, with no
 * compile error anywhere to say so. A record makes that a type error in this
 * file, beside the type it belongs to.
 */
const TAGGABLE: Record<TaggedFailure, true> = {
  'no-api-key': true,
  'camera-unavailable': true,
  'capture-in-progress': true,
  cancelled: true,
  expired: true,
  'no-capture': true,
}

const TAGGED = Object.keys(TAGGABLE) as readonly TaggedFailure[]

/**
 * The tag a thrown message carries, or null when it carries none.
 *
 * The primitive the two path classifiers narrow. Not for screens: see the note
 * on `TaggedFailure`.
 *
 * Electron wraps a rejection as "Error invoking remote method 'checkin:capture':
 * Error: …", so the tag is looked for anywhere in the text rather than at the
 * start of it.
 */
export function taggedFailure(error: unknown): TaggedFailure | null {
  // `String` rather than reading `.message`: an Error stringifies to
  // "Error: <message>", which still contains the tag, and this way a rejection
  // that is not an Error at all is handled by the same line.
  const text = String(error)
  // The *earliest* tag in the text wins, rather than the first in whatever
  // order the tags happen to be listed in. A message that quotes another
  // error can carry two, and the outer one — written by the code that decided
  // to throw — is the one that meant it. Order stops being load-bearing.
  let found: TaggedFailure | null = null
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

/** Which tags the capture screen has words for. */
const SHOWN_ON_CAPTURE: Record<Exclude<CaptureFailure, 'unknown'>, true> = {
  'no-api-key': true,
  'camera-unavailable': true,
  'capture-in-progress': true,
}

/** Which tags the questions screen has words for. */
const SHOWN_ON_SUBMIT: Record<Exclude<SubmitFailure, 'unknown'>, true> = {
  expired: true,
  'no-capture': true,
}

/**
 * What a failed capture should say, or null when it should say nothing.
 *
 * Null is cancellation: the person stopped the reading themselves and does not
 * need to be told what they just did. Everything the capture path cannot
 * produce — an expired reading, a missing one — is `unknown` rather than a
 * confident wrong sentence, on the same principle as an untagged throw.
 */
export function classifyCaptureError(error: unknown): CaptureFailure | null {
  const tag = taggedFailure(error)
  if (tag === 'cancelled') return null
  if (tag === null) return 'unknown'
  return tag in SHOWN_ON_CAPTURE ? (tag as CaptureFailure) : 'unknown'
}

/**
 * What a failed submit should say.
 *
 * Never null: a submit that failed always owes the person a sentence, because
 * unlike a cancelled capture they did not ask for it.
 */
export function classifySubmitError(error: unknown): SubmitFailure {
  const tag = taggedFailure(error)
  if (tag === null) return 'unknown'
  return tag in SHOWN_ON_SUBMIT ? (tag as SubmitFailure) : 'unknown'
}
