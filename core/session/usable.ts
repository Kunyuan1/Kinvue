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
  if (durationSec < MIN_CAPTURE_SECONDS) return 'too-short'
  // Unrated is not usable (KV-12). The SDK sometimes reports a rate without
  // rating it at all, and scoring that would present a number as reliable on
  // the grounds that nothing said otherwise — the reassuring direction, which
  // is the worse one. Withholding says the true thing: we cannot tell today.
  //
  // Tested for shape, not for null: `store.ts` casts parsed JSON to
  // `SessionRecord` unvalidated, so a record missing the key reads as
  // `undefined`, and `undefined < 0.5` is false — an absent confidence would
  // otherwise score as fully vouched-for, the exact failure KV-12 closes.
  if (typeof confidence !== 'number') return 'unrated'
  if (confidence < MIN_CAPTURE_CONFIDENCE) return 'low-confidence'
  return null
}
