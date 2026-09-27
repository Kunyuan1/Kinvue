import type { BaselineSpan, SessionRecord } from '../session/types'
import { unusableReason } from '../session/usable'

/**
 * A baseline is this person's own recent normal — never a population norm.
 * Comparing an 82-year-old's resting pulse to a textbook range is how you get
 * a dashboard that cries wolf every morning; comparing it to their own recent
 * check-ins is the thing a caregiver cannot do by eye. "Recent" is their last
 * 14 usable ones — a fortnight for someone who checks in daily, and further
 * back, with no age bound, for someone who does not (KV-99).
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
   * which is what the "1 of 3 usable check-ins" count is telling a
   * caregiver they are waiting for (KV-72).
   */
  sessions: number
  /**
   * Earlier sessions the scorer refused, across the whole history rather than
   * the window: the refusals `sessions` excluded. Not everything it leaves out
   * — past the window, older usable sessions are left out too. Carried so a
   * card still learning can say why its count is lower than the check-ins done
   * (KV-100) — excluding them was right for the mean, but the count alone
   * hides them.
   */
  refusedSessions: number
  /**
   * The stretch the window covers, or null with no sessions in it (KV-154).
   * The window is the trailing 14 usable sessions however old
   * (`BASELINE_WINDOW_SESSIONS`), so it can reach back over a year, or be a
   * fortnight that ended months ago; "their usual" means something different
   * in each, and the caregiver cannot see the window any other way.
   */
  span: BaselineSpan | null
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
 * daily it reaches back further than the fortnight this used to claim. The
 * aim of a trailing window is that a slow drift moves the baseline with it
 * rather than reading as a deviation forever — which holds for someone who
 * checks in often, and, with no age bound, not for someone who rarely does
 * (below).
 *
 * Applied *after* the usability filter (KV-72 review). Taking the last 14
 * records and then discarding the unusable ones made a bad run delete an
 * established baseline: 30 good captures behind 14 refused ones left
 * `sessions` at 0, and the card fell back to "Still learning their normal".
 * Twelve of fourteen was enough to drop under `MIN_BASELINE_SESSIONS` and
 * switch daily comparison off entirely.
 *
 * **No age bound, on purpose for now** (KV-99). The window reaches back as
 * far as it must for 14 usable sessions, so for someone who checks in rarely
 * it can hold readings a year old, and a slow drift can read as a deviation.
 * Bounding it by calendar age would fix that, at the cost of a new tuned
 * horizon with no evidence behind it — which is the whole reason it waits on
 * #22's calibration. (A *short* bound would also let a bad fortnight empty the
 * baseline, the KV-72 failure again; a long one floored so it never drops the
 * set below `MIN_BASELINE_SESSIONS` would not. So what is missing is only the
 * number.) A long, sparse history pins today's behaviour in the meantime, and
 * the dashboard says how far back the usual reaches, and a card when its own
 * had gone stale (KV-154, `span` below).
 */
export const BASELINE_WINDOW_SESSIONS = 14

function spanOf(usable: readonly SessionRecord[]): BaselineSpan | null {
  const oldest = usable[0]
  const newest = usable[usable.length - 1]
  return oldest === undefined || newest === undefined
    ? null
    : { from: oldest.capturedAt, to: newest.capturedAt }
}

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
export function computeBaseline(history: readonly SessionRecord[]): Baseline {
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
  const usableAll = history
    .filter((s) => unusableReason(s.vitals) === null)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const usable = usableAll.slice(-BASELINE_WINDOW_SESSIONS)

  const pick = (get: (s: SessionRecord) => number | null): number[] =>
    usable.map(get).filter((v): v is number => v !== null)

  return {
    sessions: usable.length,
    refusedSessions: history.length - usableAll.length,
    span: spanOf(usable),
    seededSessions: usable.filter((s) => s.seeded === true).length,
    pulseRateBpm: stat(pick((s) => s.vitals.pulseRateBpm)),
    breathingRateBrpm: stat(pick((s) => s.vitals.breathingRateBrpm)),
    hrvRmssdMs: stat(pick((s) => s.vitals.hrvRmssdMs)),
  }
}
