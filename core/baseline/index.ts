import type { SessionRecord } from '../session/types'
import { unusableReason } from '../session/usable'

/**
 * A baseline is this person's own recent normal — never a population norm.
 * Comparing an 82-year-old's resting pulse to a textbook range is how you get
 * a dashboard that cries wolf every morning; comparing it to their own last
 * fortnight is the thing a caregiver cannot do by eye.
 */

export interface Stat {
  mean: number
  /** Sample standard deviation. 0 when fewer than two readings contributed. */
  sd: number
  /** How many readings contributed. */
  n: number
}

export interface Baseline {
  /**
   * Sessions the scorer was willing to use.
   *
   * The same predicate the scorer gates a verdict on — not merely "had a
   * number in it". It counts captures that will actually inform a comparison,
   * which is what the "1 of 3 check-ins needed" progress is telling a
   * caregiver they are waiting for (KV-72).
   */
  sessions: number
  /**
   * How many of those were seeded demo history (KV-8) rather than measured.
   * Carried so a verdict can say what it was compared against: a real reading
   * scored against an invented fortnight is not a reading of anyone, and the
   * card must not look like one that was. (KV-53)
   */
  seededSessions: number
  pulseRateBpm: Stat | null
  breathingRateBrpm: Stat | null
  hrvRmssdMs: Stat | null
}

/**
 * Below this, the rules that compare against a baseline are suppressed and the
 * session is flagged `insufficient-signal` instead. Three is not a
 * statistically satisfying number — it is the smallest one that is honest
 * about being provisional, and the demo persona is seeded well past it (KV-8).
 */
export const MIN_BASELINE_SESSIONS = 3

/**
 * How many *usable* sessions feed the baseline — the trailing 14 of them.
 *
 * Counted in sessions rather than days, so for anyone who does not check in
 * daily it already reaches back further than the fortnight this used to claim.
 * The point is the same either way: a slow seasonal drift should move the
 * baseline with it rather than read as a deviation forever.
 *
 * Applied *after* the usability filter (KV-72 review). Taking the last 14
 * records and then discarding the unusable ones made a bad run delete an
 * established baseline: 30 good captures behind 14 refused ones left
 * `sessions` at 0, and the card fell back to "Still learning their normal".
 * Twelve of fourteen was enough to drop under `MIN_BASELINE_SESSIONS` and
 * switch daily comparison off entirely.
 *
 * Bounding this by calendar age as well — so sparse usable captures cannot
 * anchor to something months old — is #99, because it means a new tuned
 * constant rather than a reordering.
 */
export const BASELINE_WINDOW_SESSIONS = 14

function stat(values: number[]): Stat | null {
  if (values.length === 0) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  if (values.length < 2) return { mean, sd: 0, n: values.length }
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return { mean, sd: Math.sqrt(variance), n: values.length }
}

/**
 * Build a baseline from a person's prior sessions.
 *
 * `history` must exclude the session being scored — a reading compared against
 * a baseline it is part of pulls the baseline toward itself and understates
 * every deviation.
 */
export function computeBaseline(history: SessionRecord[]): Baseline {
  // The same question the scorer asks before it will score a capture at all.
  // A capture stored as `insufficient-signal` because the SDK rated it 0.46
  // used to land in here anyway, so the app declined to show a number on one
  // card and quoted it as "their usual" on the next (KV-72). `unusableReason`
  // subsumes the old "has at least one reading" test — that is its first
  // branch — so this is strictly narrower, never wider.
  //
  // Filtered before the window is taken, not after: see
  // `BASELINE_WINDOW_SESSIONS`. The order only became load-bearing once the
  // predicate could fire on ordinary bad lighting.
  const usable = [...history]
    .filter((s) => unusableReason(s.vitals) === null)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(-BASELINE_WINDOW_SESSIONS)

  const pick = (get: (s: SessionRecord) => number | null): number[] =>
    usable.map(get).filter((v): v is number => v !== null)

  return {
    sessions: usable.length,
    seededSessions: usable.filter((s) => s.seeded === true).length,
    pulseRateBpm: stat(pick((s) => s.vitals.pulseRateBpm)),
    breathingRateBrpm: stat(pick((s) => s.vitals.breathingRateBrpm)),
    hrvRmssdMs: stat(pick((s) => s.vitals.hrvRmssdMs)),
  }
}
