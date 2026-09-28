import {
  baselineWindow,
  computeBaseline,
  MIN_BASELINE_SESSIONS,
  type Baseline,
  type Stat,
} from '../baseline'
import {
  canBeCalledUsual,
  METRIC_NAME,
  READING_LABEL,
  READING_UNIT,
  readingText,
} from '../scoring'
import type { ComparedMetric, SessionRecord, Vitals } from '../session/types'
import { unusableReason } from '../session/usable'

/**
 * One metric over the baseline window, with the latest check-in marked and the
 * usual it was compared against drawn behind it (KV-4).
 *
 * Shaped here rather than in React because the caregiver's own client (#42)
 * needs exactly the same series and will not be running this renderer. What
 * the chart *says* — every caveat under it — is composed here too, like every
 * other sentence the app shows, so the two clients cannot word it differently.
 *
 * It is a view of the baseline, not a second opinion. The points are
 * `baselineWindow` of the check-ins before the latest one, the line is
 * `computeBaseline`'s mean for them, and it is drawn only where
 * `canBeCalledUsual` would let a rule quote it: the chart never shows a usual
 * the card below it declined to use (KV-71). Severity is not plotted — the
 * flag is not a number.
 */

/** The metrics a trend can show, in the order the card lists them. */
export const TREND_METRICS: readonly ComparedMetric[] = ['pulse', 'breathing', 'hrv']

const READING: Record<ComparedMetric, (v: Vitals) => number | null> = {
  pulse: (v) => v.pulseRateBpm,
  breathing: (v) => v.breathingRateBrpm,
  hrv: (v) => v.hrvRmssdMs,
}

const USUAL: Record<ComparedMetric, (b: Baseline) => Stat | null> = {
  pulse: (b) => b.pulseRateBpm,
  breathing: (b) => b.breathingRateBrpm,
  hrv: (b) => b.hrvRmssdMs,
}

export interface TrendPoint {
  id: string
  capturedAt: string
  /**
   * The zone it was captured in (KV-28), for showing its date where it
   * happened. Absent on a record from before zones were kept: unknown.
   */
  timeZone?: string
  value: number
  /** Seeded demo data (KV-8): drawn differently, never passed off as measured. */
  seeded: boolean
  /** The latest usable check-in — the one the usual is drawn for. */
  latest: boolean
}

export interface Trend {
  metric: ComparedMetric
  /** Oldest first. Only check-ins that measured this metric and could be used. */
  points: TrendPoint[]
  /**
   * The usual the latest check-in was compared against, or null when there
   * was none to compare with: too few readings of this metric (KV-71).
   */
  usual: number | null
  /** Readings of this metric behind that usual, whether or not it is one yet. */
  usualReadings: number
  /** Whether the latest check-in measured this metric at all. */
  latestMeasured: boolean
  /** How many of `points` are seeded demo data. */
  seededPoints: number
  /**
   * Usable check-ins from the first point drawn to the latest: the stretch the
   * chart spans, which `points` undercounts when some did not measure this
   * metric (review of #162).
   */
  checkIns: number
  /**
   * This person's check-ins in that stretch that could not be used, so are not
   * plotted: a point on a line carries no "not trusted" beside it, the way a
   * card's sentence does (KV-12). The stretch runs from the first point to the
   * latest, so this follows the metric shown. A lone point that is the latest
   * has no stretch, and looks back instead: from just after the usable check-in
   * before it, or from the start, so a first week of failed captures is said.
   */
  refused: number
  /**
   * Check-ins after the latest usable one that could not be used: the chart's
   * newest point is not their newest check-in, and a caregiver reading the chart
   * first should be told (review of #162).
   */
  refusedSince: number
}

/**
 * The trend for one person and metric, or null with no usable check-in to
 * draw. `records` is everyone's; only this person's are read.
 */
export function trendOf(
  records: readonly SessionRecord[],
  personId: string,
  metric: ComparedMetric,
): Trend | null {
  const theirs = records
    .filter((r) => r.personId === personId)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const usable = theirs.filter((r) => unusableReason(r.vitals) === null)
  const latest = usable[usable.length - 1]
  if (latest === undefined) return null

  // What the latest check-in was scored against: the check-ins before it.
  const before = theirs.filter((r) => r.capturedAt < latest.capturedAt)
  const window = baselineWindow(before)
  const stat = USUAL[metric](computeBaseline(before))
  const read = READING[metric]

  const points = [...window, latest].flatMap((r): TrendPoint[] => {
    const value = read(r.vitals)
    return value === null
      ? []
      : [
          {
            id: r.id,
            capturedAt: r.capturedAt,
            ...(r.timeZone === undefined ? {} : { timeZone: r.timeZone }),
            value,
            seeded: r.seeded === true,
            latest: r === latest,
          },
        ]
  })

  const first = points[0]
  const refusedAt = (r: SessionRecord): boolean => unusableReason(r.vitals) !== null
  // The stretch the chart spans: from its first point to the latest, so a
  // refusal counts only where the reader would expect a point for it, whichever
  // metric is shown. A lone point that is the latest has no stretch, and looks
  // back instead, to the usable check-in before it or to the start — a first
  // week of failed captures is exactly when the chart must not be silent.
  const lone = points.length === 1 && first?.latest === true
  const earlier = lone ? usable.filter((r) => r.capturedAt < latest.capturedAt).at(-1) : undefined
  const inStretch = (r: SessionRecord): boolean =>
    first !== undefined &&
    r.capturedAt <= latest.capturedAt &&
    (lone
      ? earlier === undefined || r.capturedAt > earlier.capturedAt
      : r.capturedAt >= first.capturedAt)

  return {
    metric,
    points,
    usual: canBeCalledUsual(stat) ? stat.mean : null,
    usualReadings: stat?.n ?? 0,
    latestMeasured: read(latest.vitals) !== null,
    seededPoints: points.filter((p) => p.seeded).length,
    checkIns: usable.filter(
      (r) => first !== undefined && r.capturedAt >= first.capturedAt && inStretch(r),
    ).length,
    refused: theirs.filter((r) => refusedAt(r) && inStretch(r)).length,
    refusedSince: theirs.filter((r) => refusedAt(r) && r.capturedAt > latest.capturedAt).length,
  }
}

/**
 * Round values for a chart's value axis covering [lo, hi]: the smallest step
 * of 1, 2 or 5 × 10^k that leaves at most five, so a narrow range still gets
 * three or more to read a point against. Rounding the step *up* to the next
 * round number instead left breathing (14–19) with one tick and an HRV of 24
 * under the lowest (KV-4, seen on screen). Here, not in the renderer, so the
 * caregiver's client draws the same axis.
 */
export function axisTicks(lo: number, hi: number): number[] {
  if (!(hi > lo)) return [lo]
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / 5))
  const step =
    [1, 2, 5, 10, 20]
      .map((m) => m * mag)
      .find((s) => Math.floor(hi / s) - Math.ceil(lo / s) + 1 <= 5) ?? 20 * mag
  const ticks: number[] = []
  for (let i = Math.ceil(lo / step); i * step <= hi; i++) ticks.push(Number((i * step).toFixed(10)))
  return ticks
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * What the chart is of: "Pulse, bpm, over the last 12 check-ins.", or, when
 * some did not measure it, "HRV, ms: 3 readings over the last 14 check-ins."
 * Readings and check-ins are counted apart, since they differ whenever a
 * metric goes unmeasured, and "at the latest check-in" is said only when the
 * one reading is the latest's (review of #162). Named and unit'd as the card's
 * readings row names them.
 *
 * "The last" and "the latest" are said only while they are true of every
 * check-in, not just the usable ones: with a refusal in the stretch or after
 * it, the last 5 usable check-ins are not the last 5, and the note under the
 * title says the newest could not be used (second review of #162). The count
 * is then of the check-ins that could be used, and says so.
 */
export function trendTitle(trend: Trend): string {
  const n = trend.points.length
  const k = trend.checkIns
  const what = `${READING_LABEL[trend.metric]}, ${READING_UNIT[trend.metric]}`
  if (n === 1 && trend.points[0]?.latest === true) {
    return trend.refusedSince === 0
      ? `${what}, at the latest check-in.`
      : `${what}, at the latest check-in that could be used.`
  }
  const span =
    trend.refused === 0 && trend.refusedSince === 0
      ? `the last ${k} check-ins`
      : `${k} check-ins that could be used`
  if (n === k) return `${what}, over ${span}.`
  return `${what}: ${n} reading${n === 1 ? '' : 's'} over ${span}.`
}

/**
 * "their usual 72 bpm" — the line's own label, rounded by `readingText` as
 * every reading and every rule's quote is, so it quotes the number the card
 * beside it quotes. In the chart's unit, not the rules' prose one: the point
 * beside it reads "15 br/min", and a key saying "breaths/min" was the drift
 * the first review of #162 was about.
 */
export function usualLabel(trend: Trend): string | null {
  return trend.usual === null
    ? null
    : `their usual ${readingText(trend.usual)} ${READING_UNIT[trend.metric]}`
}

/**
 * The sentences under the chart, in the order a caregiver needs them.
 *
 * First whether the newest point is their newest check-in, then whether there
 * is a usual at all: a trend over a baseline still being
 * learned must say so on the chart (#17), and it is said per metric, since
 * HRV routinely has fewer readings than pulse. Then what the points are not:
 * the latest check-in when it did not measure this, seeded days, check-ins
 * that could not be used. No relative time words beyond "latest", which is
 * what the chart is drawn for (KV-93).
 */
export function trendNotes(trend: Trend): string[] {
  const name = METRIC_NAME[trend.metric]
  const notes: string[] = []
  // First, since the chart is read before the cards: its newest point is not
  // their newest check-in (review of #162).
  // With nothing drawn there is no point to be the earlier one.
  if (trend.refusedSince > 0) {
    const then = trend.points.length > 0 ? ', so the latest point here is an earlier one.' : '.'
    notes.push(
      trend.refusedSince === 1
        ? `The most recent check-in could not be used${then}`
        : `The ${trend.refusedSince} most recent check-ins could not be used${then}`,
    )
  }
  if (trend.usual === null) {
    notes.push(
      `No usual for ${name} yet — ${trend.usualReadings} of the ${MIN_BASELINE_SESSIONS} ` +
        'readings needed, so there is no line to compare with.',
    )
  }
  if (!trend.latestMeasured) {
    notes.push(`${capitalise(name)} was not measured at the latest check-in.`)
  }
  if (trend.seededPoints > 0) {
    notes.push(
      trend.seededPoints === trend.points.length
        ? 'Every point here is seeded demo data, not measured.'
        : `${trend.seededPoints} of these points are seeded demo data, not measured.`,
    )
  }
  if (trend.refused > 0) {
    // A lone point has no stretch to speak of: the refusals were before it.
    const where =
      trend.points.length === 1 && trend.points[0]?.latest === true ? 'before it' : 'over this stretch'
    notes.push(
      trend.refused === 1
        ? `1 check-in ${where} could not be used, so it is not shown.`
        : `${trend.refused} check-ins ${where} could not be used, so they are not shown.`,
    )
  }
  return notes
}
