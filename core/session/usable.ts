import type { Vitals } from './types'

/**
 * Whether a capture is one the app is willing to use.
 *
 * Lives here rather than in `core/scoring` because two callers need the same
 * answer and they sit on opposite sides of an import edge: the scorer gates a
 * verdict on it, and `computeBaseline` decides what counts as "their usual".
 * `core/scoring` already imports `core/baseline`, so the predicate could not
 * stay where it was without a cycle — and a second copy is exactly the drift
 * `hasScorableVitals` was exported to prevent (KV-72).
 *
 * `core/scoring` re-exports all of this, so importers there are unaffected.
 *
 * **Why `core/session/` and not a module of its own.** This file puts two tuned
 * constants in a directory that was otherwise shapes (`types.ts`) and mechanics
 * (`store.ts`, `time.ts`, `validate.ts`), and "the capture thresholds live in
 * core/session" is a surprising sentence (KV-72 review). It earns its place
 * here because `Vitals` does: the predicate is a question about one record's
 * vitals and imports nothing else, so it sits next to the type it interrogates
 * rather than in a directory of one file.
 *
 * `core/capture/` was the other candidate and does not work — `length.ts` there
 * imports `core/scoring`, so hosting the predicate would put `scoring` and
 * `capture` on both ends of an edge. A sibling `core/usable/` would avoid both
 * objections; it was not taken because a directory holding a single file is its
 * own kind of surprise. Worth revisiting if a third caller appears, or if
 * anything else in here grows a dependency beyond `./types`.
 */

/** Below this mean SDK confidence the capture is not scored at all. */
export const MIN_CAPTURE_CONFIDENCE = 0.5

/**
 * Captures shorter than this are not scored.
 *
 * Load-bearing since captures became adaptive (KV-63). A fixed clock plus
 * `SHORTEST_USEFUL_SECONDS` made this unreachable; an early stop can end a
 * capture as soon as every metric has arrived, so `captureVitals` checks the
 * seconds recorded so far against this before it stops. Without that, a
 * capture that collected all three metrics quickly would be stored as
 * `too-short` — the verdict for one that collected nothing.
 */
export const MIN_CAPTURE_SECONDS = 20

/**
 * Whether a capture measured anything a rule can read.
 *
 * `hrvSdnnMs` is deliberately not in the list: nothing scores on it, so a
 * capture that produced only SDNN has nothing to say. Exported because the
 * renderer offers a retake on exactly this question, and a second copy of the
 * list would drift — a capture the scorer would happily score must never be
 * shown to the person as "nothing was measured".
 */
export function hasScorableVitals(vitals: Vitals): boolean {
  return (
    vitals.pulseRateBpm !== null ||
    vitals.breathingRateBrpm !== null ||
    vitals.hrvRmssdMs !== null
  )
}

/** Why a capture cannot be scored. Null means it can. */
export type UnusableReason = 'nothing-measured' | 'too-short' | 'unrated' | 'low-confidence'

/**
 * The first reason this capture cannot be scored, or null when it can.
 *
 * A reason rather than a boolean because the card has to say which one
 * happened. A capture cut short at 8s and a capture the SDK rated 0.2 are
 * different things for a caregiver to be told, and the same argument that
 * separates "unrated" from "judged and found poor" separates these.
 *
 * Order is deliberate, and it is not the order of the thresholds. The reason
 * given is the one that explains the most and that someone could act on:
 * nothing measured at all comes first because the other three describe a
 * reading; a short capture comes before either confidence branch because a
 * camera that ran for 8s is *why* the reading is thin or unrated, and it is
 * the one thing the person in front of it could have done differently.
 */
export function unusableReason(vitals: Vitals): UnusableReason | null {
  const { confidence, durationSec } = vitals
  if (!hasScorableVitals(vitals)) return 'nothing-measured'

  // Both numeric tests are written `!(x >= n)` rather than `x < n`, so a value
  // that is not a number at all lands on the withholding side.
  //
  // `store.ts` casts parsed JSON to `SessionRecord` without validating it, so
  // a record missing a key reads as `undefined` — and `undefined < 20` and
  // `undefined < 0.5` are both false, which would walk a record past this gate
  // as a full-length, fully vouched-for capture. `NaN` does the same, and
  // slips `typeof === 'number'` too. Until KV-72 this was academic: the only
  // vitals reaching here came from a capture the main process had just
  // measured, where both fields are real numbers by construction. Pointing the
  // predicate at every record in the history file is what made the shape
  // discipline load-bearing (KV-72 review).
  if (!(durationSec >= MIN_CAPTURE_SECONDS)) return 'too-short'

  // Unrated is not usable (KV-12). The SDK sometimes reports a rate without
  // rating it at all, and scoring that would present a number as reliable on
  // the grounds that nothing said otherwise — the reassuring direction, which
  // is the worse one. Withholding says the true thing: we cannot tell today.
  // `typeof` first because it is what narrows `number | null` for the compare
  // below; `isFinite` is what rejects NaN, which passes `typeof` happily.
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 'unrated'
  if (!(confidence >= MIN_CAPTURE_CONFIDENCE)) return 'low-confidence'
  return null
}
