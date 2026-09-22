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
  /**
   * The capture failed and the device has no internet connection (KV-104).
   *
   * A reading needs one: the SDK reaches Presage when a session starts, and
   * without it a capture fails fast and produces nothing. It reports that as
   * `kProcessingFailed`, the same code a bad capture gets, so this tag is set
   * from `net.isOnline()` rather than from anything the SDK said.
   */
  | 'no-connection'
  /** A capture is already running, so another cannot start. */
  | 'capture-in-progress'
  /** The person stopped it. Not a failure to report as one. */
  | 'cancelled'
  /** The reading waited too long for its answers and is no longer offered. */
  | 'expired'
  /** The reading is gone: already submitted, replaced, or never existed. */
  | 'no-capture'
  /**
   * The stored history exists and could not be parsed, so nothing was read
   * and nothing was written (KV-13).
   *
   * Tagged because it is the one failure on the submit path that retrying
   * cannot fix. Untagged it classified `unknown`, whose copy invites another
   * go — true of a full disk, false of a file that will fail identically
   * until someone moves it aside.
   */
  | 'store-unreadable'

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
  | 'no-connection'
  | 'capture-in-progress'
  /** Anything unclassified. Shown as a short line, never as a stack trace. */
  | 'unknown'

/** What the questions screen can be asked to say when answers cannot be stored. */
export type SubmitFailure =
  | 'expired'
  | 'no-capture'
  /** The history file cannot be read, so the answers have nowhere to go. */
  | 'store-unreadable'
  /** Anything unclassified. The scorer carries no tag. */
  | 'unknown'

/** The prefix a thrown message carries, e.g. `kinvue/expired: …`. */
export const failureTag = (failure: TaggedFailure): string => `kinvue/${failure}`

/**
 * Where every tag goes on the capture path. `null` means say nothing.
 *
 * **Total over `TaggedFailure`, and that is the point.** Listing only the tags
 * a screen has words for left the *routing* decision unenforced: a member added
 * to the union could be tagged correctly at the throw, read back correctly off
 * the wire, and then classified `unknown` on both screens with no compile error
 * anywhere saying nobody had decided where it belonged. That is the KV-7 bug
 * with a different table forgetting it — same tagged throw, same `unknown` at
 * the screen, same silence from the compiler.
 *
 * A total record makes adding a tag an error *here*, beside the type, and the
 * error is "you have not said what this means on each path" rather than "you
 * have not listed it". It also removes the cast this used to need, which is
 * what let `CaptureFailure` drift out of `TaggedFailure` unnoticed: the value
 * side is checked against `CaptureFailure`, so a member of one that is not a
 * member of the other no longer compiles.
 */
const ON_CAPTURE: Record<TaggedFailure, CaptureFailure | null> = {
  'no-api-key': 'no-api-key',
  'camera-unavailable': 'camera-unavailable',
  'no-connection': 'no-connection',
  'capture-in-progress': 'capture-in-progress',
  // They pressed stop, so they already know. Null, not a sentence.
  cancelled: null,
  // The capture path cannot raise these. If one ever arrives it is not a
  // capture failure this screen has words for, so it gets the same answer as
  // an untagged throw. See the note on `classifyCaptureError` about what that
  // answer currently says out loud.
  expired: 'unknown',
  'no-capture': 'unknown',
  // The capture path never opens the store — it holds the reading in memory
  // and only `submit` reads history. Routed here because the record is total,
  // not because this screen expects it.
  'store-unreadable': 'unknown',
}

/** Where every tag goes on the submit path. Never null: see `classifySubmitError`. */
const ON_SUBMIT: Record<TaggedFailure, SubmitFailure> = {
  // The submit path cannot raise any of these — they are all about the camera,
  // which has been closed since before the questions were asked.
  'no-api-key': 'unknown',
  'camera-unavailable': 'unknown',
  // The submit path does not open the camera, so it cannot raise this either.
  'no-connection': 'unknown',
  'capture-in-progress': 'unknown',
  cancelled: 'unknown',
  expired: 'expired',
  'no-capture': 'no-capture',
  'store-unreadable': 'store-unreadable',
}

/**
 * Derived from the routing rather than from a third list: a tag that nothing
 * routes is a tag no screen decided about, and that is now impossible to write.
 */
const TAGGED = Object.keys(ON_CAPTURE) as readonly TaggedFailure[]

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

/**
 * What a failed capture should say, or null when it should say nothing.
 *
 * Null is cancellation: the person stopped the reading themselves and does not
 * need to be told what they just did. A caller that gets null has nothing to
 * show *and nothing left to show it on* — see `App`, which leaves the capture
 * screen rather than rendering it with no failure.
 *
 * A tag belonging to the other path answers `unknown`, the same as an untagged
 * throw. Worth being honest about what that means today: `unknown` on this
 * screen reads "Something went wrong with the camera", which is a claim, not a
 * shrug. It is the right answer for a genuinely unknown failure and the wrong
 * one for a reading that merely aged out. Nothing can reach it on this path as
 * the code stands — the partition holds — so this is a hazard in the copy, not
 * a live bug, and it is KV-80 rather than a sentence changed here.
 */
export function classifyCaptureError(error: unknown): CaptureFailure | null {
  const tag = taggedFailure(error)
  return tag === null ? 'unknown' : ON_CAPTURE[tag]
}

/**
 * What a failed submit should say.
 *
 * Never null: a submit that failed always owes the person a sentence, because
 * unlike a cancelled capture they did not ask for it.
 */
export function classifySubmitError(error: unknown): SubmitFailure {
  const tag = taggedFailure(error)
  return tag === null ? 'unknown' : ON_SUBMIT[tag]
}
