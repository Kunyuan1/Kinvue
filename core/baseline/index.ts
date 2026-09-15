import type { SessionRecord } from '../session/types'

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
  /** Sessions that contributed at least one usable reading. */
  sessions: number
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
 * Only the trailing two weeks feed the baseline. A slow seasonal drift should
 * move the baseline with it rather than read as a deviation forever.
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
  const recent = [...history]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(-BASELINE_WINDOW_SESSIONS)

  const usable = recent.filter(
    (s) =>
      s.vitals.pulseRateBpm !== null ||
      s.vitals.breathingRateBrpm !== null ||
      s.vitals.hrvRmssdMs !== null,
  )

  const pick = (get: (s: SessionRecord) => number | null): number[] =>
    usable.map(get).filter((v): v is number => v !== null)

  return {
    sessions: usable.length,
    pulseRateBpm: stat(pick((s) => s.vitals.pulseRateBpm)),
    breathingRateBrpm: stat(pick((s) => s.vitals.breathingRateBrpm)),
    hrvRmssdMs: stat(pick((s) => s.vitals.hrvRmssdMs)),
  }
}
