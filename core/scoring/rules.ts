import { MIN_BASELINE_SESSIONS, type Baseline, type Stat } from '../baseline'
import type { FiredRule, SessionRecord } from '../session/types'

/**
 * Every rule is a small, named, independently testable function. A rule that
 * fires must say *why* in numbers the caregiver can check — that explanation is
 * the product, not a debugging aid. Nothing here is trained; see
 * ARCHITECTURE.md for why a rule engine is the deliberate choice.
 */

export interface RuleContext {
  session: SessionRecord
  /** Built from the person's prior sessions only, never including this one. */
  baseline: Baseline
}

export interface Rule {
  id: string
  /**
   * True when the rule's explanation quotes "their usual" — that is, when what
   * it says out loud depends on the baseline. Whether that baseline was seeded
   * is then something the card has to disclose (KV-53), so the scorer needs to
   * know which fired rules lean on it.
   */
  usesBaseline?: true
  /** Returns null when the rule does not fire. */
  evaluate(ctx: RuleContext): FiredRule | null
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
const round = (n: number, dp = 0): number => Number(n.toFixed(dp))

/**
 * HRV falls under physiological stress, illness onset and poor sleep, and it
 * moves earlier than pulse does. It is the single most useful number this app
 * collects — which is also why it needs a per-person baseline to mean anything.
 */
const HRV_DROP_FIRES_AT = 0.25
const HRV_DROP_FULL_SEVERITY_AT = 0.5

/**
 * Whether a metric's own history is deep enough to be called "their usual".
 *
 * Counted per metric rather than per session (KV-71). `Baseline.sessions` counts
 * sessions that produced *some* reading, and a capture routinely produces some
 * vitals and not others — `Vitals` says so, and HRV is the standing example. So
 * three sessions can back a pulse mean and a single breathing reading, and the
 * card would quote "their usual 15 breaths/min" off one morning.
 *
 * `Stat.n` is the count that actually backs the number being quoted, and it is
 * never greater than `Baseline.sessions`, so this gate subsumes the session
 * count rather than sitting beside it.
 */
const canBeCalledUsual = (usual: Stat | null): usual is Stat =>
  usual !== null && usual.n >= MIN_BASELINE_SESSIONS

export const hrvDrop: Rule = {
  id: 'hrv-drop',
  usesBaseline: true,
  evaluate({ session, baseline }) {
    const value = session.vitals.hrvRmssdMs
    const usual = baseline.hrvRmssdMs
    if (value === null || !canBeCalledUsual(usual) || usual.mean <= 0) return null

    const drop = (usual.mean - value) / usual.mean
    if (drop < HRV_DROP_FIRES_AT) return null

    return {
      id: 'hrv-drop',
      title: 'Heart-rate variability below usual',
      explanation:
        `HRV was ${round(value)} ms today, about ${round(drop * 100)}% below ` +
        `their usual ${round(usual.mean)} ms.`,
      severity: 0.6 * clamp01(drop / HRV_DROP_FULL_SEVERITY_AT),
    }
  },
}

/**
 * Pulse and breathing are compared in standard deviations rather than fixed
 * thresholds: a person whose resting pulse is steady at 58 and one who varies
 * between 60 and 90 should not trip the same alarm at 85.
 */
const Z_FIRES_AT = 2
const Z_FULL_SEVERITY_AT = 4
/** Guards against a near-zero sd from an unusually consistent fortnight. */
const MIN_SD_FRACTION_OF_MEAN = 0.02

function zRule(
  id: string,
  title: string,
  unit: string,
  peakSeverity: number,
  get: (s: SessionRecord) => number | null,
  usualOf: (b: Baseline) => Baseline['pulseRateBpm'],
): Rule {
  return {
    id,
    usesBaseline: true,
    evaluate({ session, baseline }) {
      const value = get(session)
      const usual = usualOf(baseline)
      if (value === null || !canBeCalledUsual(usual)) return null

      // The floor below only damps a real spread. On one or two readings there
      // is no spread to damp and the floor *is* the scale, which is why the
      // gate above is about this metric's own n (KV-71).
      const sd = Math.max(usual.sd, usual.mean * MIN_SD_FRACTION_OF_MEAN)
      if (sd <= 0) return null

      const z = (value - usual.mean) / sd
      if (z < Z_FIRES_AT) return null

      return {
        id,
        title,
        explanation:
          `${title.split(' ')[0]} was ${round(value)} ${unit}, above their ` +
          `usual ${round(usual.mean)} ${unit}.`,
        severity:
          peakSeverity *
          clamp01((z - Z_FIRES_AT) / (Z_FULL_SEVERITY_AT - Z_FIRES_AT)) *
          0.5 +
          peakSeverity * 0.5,
      }
    },
  }
}

export const pulseElevated = zRule(
  'pulse-elevated',
  'Pulse above usual',
  'bpm',
  0.45,
  (s) => s.vitals.pulseRateBpm,
  (b) => b.pulseRateBpm,
)

export const breathingElevated = zRule(
  'breathing-elevated',
  'Breathing above usual',
  'breaths/min',
  0.4,
  (s) => s.vitals.breathingRateBrpm,
  (b) => b.breathingRateBrpm,
)

/**
 * Poor sleep and pain together, on the same day, is the combination carers
 * describe as the one that precedes a bad week. Either alone is weaker, and
 * fires below.
 */
export const poorSleepWithPain: Rule = {
  id: 'poor-sleep-with-pain',
  evaluate({ session }) {
    const { sleep, painReported } = session.answers
    if (sleep !== 'poorly' || !painReported) return null
    return {
      id: 'poor-sleep-with-pain',
      title: 'Poor sleep and pain reported together',
      explanation: 'They reported sleeping poorly and being in pain today.',
      severity: 0.45,
    }
  },
}

export const painReported: Rule = {
  id: 'pain-reported',
  evaluate({ session }) {
    if (!session.answers.painReported) return null
    if (session.answers.sleep === 'poorly') return null // poorSleepWithPain covers it
    return {
      id: 'pain-reported',
      title: 'Pain reported',
      explanation: 'They reported being in pain today.',
      severity: 0.25,
    }
  },
}

export const notEaten: Rule = {
  id: 'not-eaten',
  evaluate({ session }) {
    if (session.answers.eatenToday) return null
    return {
      id: 'not-eaten',
      title: 'Has not eaten today',
      explanation: 'They had not eaten yet at the time of the check-in.',
      severity: 0.3,
    }
  },
}

export const lowMood: Rule = {
  id: 'low-mood',
  evaluate({ session }) {
    if (session.answers.mood !== 'low') return null
    return {
      id: 'low-mood',
      title: 'Low mood reported',
      explanation: 'They described their mood as low today.',
      severity: 0.2,
    }
  },
}

/** Evaluation order is irrelevant to the result; output is sorted by severity. */
export const ALL_RULES: readonly Rule[] = [
  hrvDrop,
  pulseElevated,
  breathingElevated,
  poorSleepWithPain,
  painReported,
  notEaten,
  lowMood,
]

/**
 * Rules whose explanation quotes the baseline. See `Rule.usesBaseline`.
 *
 * Derived rather than listed, so `usesBaseline` is the single place the concept
 * is stated. Two hand-kept encodings agreed today and had nothing checking they
 * still would: a fourth comparison rule added with the flag and missing from
 * the list would disclose nothing on a seeded baseline, which is the failure
 * KV-53 exists to prevent.
 */
export const BASELINE_RULE_IDS: ReadonlySet<string> = new Set(
  ALL_RULES.filter((rule) => rule.usesBaseline === true).map((rule) => rule.id),
)
