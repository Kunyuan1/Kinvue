import { MIN_BASELINE_SESSIONS, type Baseline, type Stat } from '../baseline'
import type {
  ComparedMetric,
  FiredRule,
  SessionRecord,
  UncomparedMetric,
  Vitals,
} from '../session/types'

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

/** Which metric a rule compares against their usual, and where both are found. */
export interface Comparison {
  metric: ComparedMetric
  reading: (v: Vitals) => number | null
  usual: (b: Baseline) => Stat | null
}

export interface Rule {
  id: string
  /**
   * The metric this rule compares against their usual; absent on a rule that
   * reads only the answers.
   *
   * The single statement of two facts the scorer needs. A rule that compares
   * quotes "their usual", so whether that usual was seeded has to be
   * disclosed wherever it fires (KV-53, `BASELINE_RULE_IDS`). And a reading
   * of its metric with no usual yet is a gap in the comparison, which keeps
   * the verdict from reading "normal" (KV-87, `uncomparedMetrics`). Both are
   * derived from this field, so a new comparison rule cannot be added to one
   * list and forgotten from the other — that happened once (KV-71).
   */
  compares?: Comparison
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
 * sessions the scorer was willing to use (KV-72), and a usable capture routinely
 * produces some vitals and not others — `Vitals` says so, and HRV is the standing
 * example. So three sessions can back a pulse mean and a single breathing
 * reading, and the card would quote "their usual 15 breaths/min" off one morning.
 *
 * `Stat.n` is the count that actually backs the number being quoted, and it is
 * never greater than `Baseline.sessions`, so this gate subsumes the session
 * count rather than sitting beside it.
 */
const canBeCalledUsual = (usual: Stat | null): usual is Stat =>
  usual !== null && usual.n >= MIN_BASELINE_SESSIONS


const HRV_COMPARISON: Comparison = {
  metric: 'hrv',
  reading: (v) => v.hrvRmssdMs,
  usual: (b) => b.hrvRmssdMs,
}

export const hrvDrop: Rule = {
  id: 'hrv-drop',
  compares: HRV_COMPARISON,
  evaluate({ session, baseline }) {
    const value = HRV_COMPARISON.reading(session.vitals)
    const usual = HRV_COMPARISON.usual(baseline)
    if (value === null || !canBeCalledUsual(usual) || usual.mean <= 0) return null

    const drop = (usual.mean - value) / usual.mean
    if (drop < HRV_DROP_FIRES_AT) return null

    return {
      id: 'hrv-drop',
      title: 'Heart-rate variability below usual',
      explanation:
        `HRV was ${round(value)} ms, about ${round(drop * 100)}% below ` +
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

interface ZRuleSpec {
  id: string
  title: string
  /**
   * What the explanation calls the thing, e.g. "Breathing".
   *
   * Stated rather than taken from `title.split(' ')[0]`, which happened to
   * work only because every title began with its own noun (KV-11). A title
   * reworded to "Unusually fast breathing" would have produced "Unusually was
   * 40 breaths/min".
   */
  noun: string
  unit: string
  /**
   * The unit to use when the quoted number is exactly 1, e.g. "breath/min".
   *
   * Defaults to `unit`, which is already right for "bpm". Stated rather than
   * derived for the same reason as `noun`: guessing a singular out of a plural
   * is the string surgery this file just removed, and "about 1 breaths/min
   * either way" is reachable for any spread that rounds to 1 (KV-11 review).
   */
  singularUnit?: string
  peakSeverity: number
  /** The metric compared, where the reading and the usual are found. */
  compares: Comparison
  /**
   * Which side of their usual fires the rule (KV-9). Pulse and breathing get
   * one rule each way, at the same thresholds and weights: a collapse is as
   * much "not their normal" as a spike, and mirroring the high side avoids
   * inventing numbers that only calibration (#22) can supply.
   */
  direction: Direction
}

type Direction = 'high' | 'low'

/**
 * The word the explanation uses for each direction. Stated rather than taken
 * from `direction` itself, for the reason `noun` is: the discriminant is a
 * name for code, and renaming it must not reach a sentence a caregiver reads
 * ("Pulse was 40 bpm, low their usual 72 bpm"). Keyed by the union, so a new
 * direction does not compile without its word (KV-9 review).
 */
const RELATION: Record<Direction, string> = {
  high: 'above',
  low: 'below',
}

/** The spread a z was measured against, and whose number it is. */
interface Spread {
  /** What the deviation was actually divided by. */
  sd: number
  /** True when `MIN_SD_FRACTION_OF_MEAN` supplied it rather than the person. */
  floored: boolean
}

/**
 * The scale a z-rule measures on, computed once.
 *
 * `zRule` derives this and hands it to `howFarOut`, so the sentence can never
 * explain a deviation on a different scale from the one that set the severity.
 * The two used to recompute the floor independently, and agreed only for as
 * long as the expression stayed typed identically in both places — give the
 * floor an absolute component and the severity would come from one scale while
 * the explanation described another, with nothing failing (KV-11 review).
 */
const spreadOf = (usual: Stat): Spread => {
  const floor = usual.mean * MIN_SD_FRACTION_OF_MEAN
  return usual.sd < floor ? { sd: floor, floored: true } : { sd: usual.sd, floored: false }
}

/** Decimal places for a quoted spread. See `howFarOut` for why it is not 0. */
const SPREAD_DP = 1

/**
 * What to say when there is no measured spread to quote.
 *
 * Stops at what is known. The earlier wording — "so a small difference is a
 * large one for them" — drew a conclusion from the floor, and the floor is
 * precisely the number this branch exists because nobody produced: five
 * identical readings at 72 means the code has never observed this person vary,
 * so it cannot know that three beats is large for them. Asserting it is the
 * same overstatement as quoting the floored sd, one level up (KV-11 review).
 * Whether a difference that small should fire at all on a baseline that steady
 * is a `MIN_SD_FRACTION_OF_MEAN` question, and #22 owns it.
 *
 * Two constraints on the wording, both learned by reading it on a real card:
 *
 * - **It must not say "usual".** The first sentence already spends that word on
 *   the mean ("above their usual 72 bpm"); spending it again on the spread
 *   reads as a contradiction rather than a distinction.
 * - **"Barely varied", not "steady".** This fires on two baselines — an sd of
 *   exactly 0, and a real sd sitting under the floor. The second person did
 *   vary, just not much, and calling that "so steady there is no range" is the
 *   same species of overstatement this branch exists to avoid.
 */
const NO_SPREAD_TO_REPORT =
  'Their recent readings have barely varied, so there is nothing to measure this difference against.'

/**
 * How far out the reading is, in words a caregiver can check.
 *
 * A z-rule fires on deviation relative to this person's own spread, so the
 * bare numbers can read as trivially true: "Pulse was 75 bpm, above their
 * usual 72 bpm" invites the answer "three beats, so what?" when the point is
 * that three beats is a lot *for them*. `hrv-drop` never had this problem
 * because a percentage carries its own magnitude.
 *
 * **Reports the observed spread only when there is one to report.** There are
 * two ways there is not, and both must say so rather than quote a number:
 *
 * - The floor supplied the scale. `MIN_SD_FRACTION_OF_MEAN` is the code's
 *   number, not the person's, and quoting it back as "they usually vary by
 *   about 1.4 bpm" would present a floor as a measurement.
 * - The measured spread is finer than this clause can print. At 0 decimal
 *   places a real sd of 0.447 rendered as "about 0 breaths/min either way" — a
 *   sentence denying the very spread the rule fired on, reachable for any mean
 *   at or below 25, which is breathing rate in every normal range (KV-11
 *   review). `SPREAD_DP` covers that; the `<= 0` guard keeps the guarantee
 *   structural rather than a property of whatever that constant happens to be.
 */
function howFarOut(spread: Spread, unit: string, singularUnit: string): string {
  const quoted = round(spread.sd, SPREAD_DP)
  if (spread.floored || quoted <= 0) return NO_SPREAD_TO_REPORT
  const u = quoted === 1 ? singularUnit : unit
  return `They usually vary by about ${quoted} ${u} either way.`
}

function zRule({
  id,
  title,
  noun,
  unit,
  singularUnit = unit,
  peakSeverity,
  compares,
  direction,
}: ZRuleSpec): Rule {
  return {
    id,
    compares,
    evaluate({ session, baseline }) {
      const value = compares.reading(session.vitals)
      const usual = compares.usual(baseline)
      if (value === null || !canBeCalledUsual(usual)) return null

      // The floor in `spreadOf` only damps a real spread. On one or two
      // readings there is no spread to damp and the floor *is* the scale,
      // which is why the gate above is about this metric's own n (KV-71).
      const spread = spreadOf(usual)
      if (spread.sd <= 0) return null

      // Measured in the rule's own direction, so both sides share one scale,
      // one threshold and one severity curve.
      const signed = (value - usual.mean) / spread.sd
      const z = direction === 'high' ? signed : -signed
      if (z < Z_FIRES_AT) return null

      return {
        id,
        title,
        explanation:
          `${noun} was ${round(value)} ${unit}, ${RELATION[direction]} their ` +
          `usual ${round(usual.mean)} ${unit}. ${howFarOut(spread, unit, singularUnit)}`,
        severity:
          peakSeverity *
          clamp01((z - Z_FIRES_AT) / (Z_FULL_SEVERITY_AT - Z_FIRES_AT)) *
          0.5 +
          peakSeverity * 0.5,
      }
    },
  }
}

/** Shared by both pulse rules, so they compare the one metric the one way. */
const PULSE: Comparison = {
  metric: 'pulse',
  reading: (v) => v.pulseRateBpm,
  usual: (b) => b.pulseRateBpm,
}

const BREATHING: Comparison = {
  metric: 'breathing',
  reading: (v) => v.breathingRateBrpm,
  usual: (b) => b.breathingRateBrpm,
}

export const pulseElevated = zRule({
  id: 'pulse-elevated',
  title: 'Pulse above usual',
  noun: 'Pulse',
  unit: 'bpm',
  peakSeverity: 0.45,
  compares: PULSE,
  direction: 'high',
})

/**
 * A reading well below their own usual (KV-9). Until this existed a pulse of
 * 80 against a usual of 97 — compared, n of 5 — produced nothing, and a person
 * whose usual drifted up got an app that stopped noticing them come down.
 */
export const pulseLow = zRule({
  id: 'pulse-low',
  title: 'Pulse below usual',
  noun: 'Pulse',
  unit: 'bpm',
  peakSeverity: 0.45,
  compares: PULSE,
  direction: 'low',
})

export const breathingElevated = zRule({
  id: 'breathing-elevated',
  title: 'Breathing above usual',
  noun: 'Breathing',
  unit: 'breaths/min',
  singularUnit: 'breath/min',
  peakSeverity: 0.4,
  compares: BREATHING,
  direction: 'high',
})

export const breathingLow = zRule({
  id: 'breathing-low',
  title: 'Breathing below usual',
  noun: 'Breathing',
  unit: 'breaths/min',
  singularUnit: 'breath/min',
  peakSeverity: 0.4,
  compares: BREATHING,
  direction: 'low',
})

/**
 * Poor sleep and pain together, on the same day, is the combination carers
 * describe as the one that precedes a bad week. Either alone is weaker, and
 * fires below — pain at a real weight, sleep at barely any (see `poorSleep`).
 */
export const poorSleepWithPain: Rule = {
  id: 'poor-sleep-with-pain',
  evaluate({ session }) {
    const { sleep, painReported } = session.answers
    if (sleep !== 'poorly' || !painReported) return null
    return {
      id: 'poor-sleep-with-pain',
      title: 'Poor sleep and pain reported together',
      explanation: 'At the check-in they reported being in pain, and sleeping poorly the night before.',
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
      explanation: 'At the check-in they reported being in pain.',
      severity: 0.25,
    }
  },
}

/**
 * Poor sleep on its own, so the caregiver can see how the question was
 * answered (KV-91). Until this existed the answer vanished without pain beside
 * it: no severity and no line on the card.
 *
 * **Weighed, but lightly, and it can tip a day.** The scorer sums every fired
 * rule, camera ones included, so a day whose other rules already sum to within
 * 0.05 of `ELEVATED_SEVERITY_THRESHOLD` — an HRV drop just short of the one that
 * flags alone, say — becomes `elevated` when they also slept poorly. That is
 * intended: a real drop plus a bad night is a better amber than the drop alone.
 *
 * What it may not do is add an answers-only flag. Without pain the answer rules
 * reach 0.5 at most (`notEaten` + `lowMood`), so under 0.1 it cannot, and KV-10
 * decided which answer combinations may flag. Two tests pin it: the answer
 * combinations that flag, and that it tips only a day already within 0.05.
 */
export const poorSleep: Rule = {
  id: 'poor-sleep',
  evaluate({ session }) {
    if (session.answers.sleep !== 'poorly') return null
    if (session.answers.painReported) return null // poorSleepWithPain covers it
    return {
      id: 'poor-sleep',
      title: 'Slept poorly',
      explanation: 'At the check-in they reported sleeping poorly the night before.',
      severity: 0.05,
    }
  },
}

export const notEaten: Rule = {
  id: 'not-eaten',
  evaluate({ session }) {
    if (session.answers.eatenToday) return null
    return {
      id: 'not-eaten',
      title: 'Had not eaten yet',
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
      explanation: 'At the check-in they described their mood as low.',
      severity: 0.2,
    }
  },
}

/** Evaluation order is irrelevant to the result; output is sorted by severity. */
export const ALL_RULES: readonly Rule[] = [
  hrvDrop,
  pulseElevated,
  pulseLow,
  breathingElevated,
  breathingLow,
  poorSleepWithPain,
  poorSleep,
  painReported,
  notEaten,
  lowMood,
]

/**
 * Rules whose explanation quotes the baseline. See `Rule.compares`.
 *
 * Derived rather than listed, so `compares` is the single place the concept
 * is stated. Two hand-kept encodings agreed today and had nothing checking they
 * still would: a fourth comparison rule added with the flag and missing from
 * the list would disclose nothing on a seeded baseline, which is the failure
 * KV-53 exists to prevent.
 */
export const BASELINE_RULE_IDS: ReadonlySet<string> = new Set(
  ALL_RULES.filter((rule) => rule.compares !== undefined).map((rule) => rule.id),
)

/**
 * The metrics this check-in measured that had no usual to compare them with
 * (KV-87), derived from the rules that compare them. A metric that produced
 * nothing is not listed: it is not a gap in the comparison, just a reading
 * that did not happen. One entry per metric, however many rules compare it.
 *
 * **The same gate the rules pass first, not every guard after it.** This asks
 * `canBeCalledUsual`, which is what holds a rule back on a thin history. A
 * rule can still decline past that gate — `zRule` on a spread of 0, `hrvDrop`
 * on a usual mean of 0 — and such a reading is neither compared nor named
 * here. Reachable only on a usual of exactly 0; closing it properly means a
 * rule reporting "could not look" apart from "looked and found nothing",
 * which is a change to `Rule.evaluate`, not to this.
 *
 * The usual's mean is kept alongside its count so the card can say what the
 * thin history showed, as evidence and not as "their usual" (KV-87 review).
 */
export function uncomparedMetrics(
  session: SessionRecord,
  baseline: Baseline,
): UncomparedMetric[] {
  const seen = new Set<ComparedMetric>()
  const gaps = ALL_RULES.flatMap(({ compares }) => {
    if (compares === undefined || seen.has(compares.metric)) return []
    seen.add(compares.metric)
    const stat = compares.usual(baseline)
    // Read before the guard: as a type guard, a `false` from
    // `canBeCalledUsual` narrows `stat` to null, and a thin history is a real
    // `Stat` with a small `n`.
    const readings = stat?.n ?? 0
    const mean = stat?.mean
    if (compares.reading(session.vitals) === null || canBeCalledUsual(stat)) return []
    const gap: UncomparedMetric = {
      metric: compares.metric,
      readings,
      needed: MIN_BASELINE_SESSIONS,
    }
    if (readings > 0 && mean !== undefined) gap.mean = mean
    return [gap]
  })
  // In the order the card shows the readings, not the order rules are listed.
  return gaps.sort((a, b) => CARD_ORDER.indexOf(a.metric) - CARD_ORDER.indexOf(b.metric))
}

const CARD_ORDER: readonly ComparedMetric[] = ['pulse', 'breathing', 'hrv']
