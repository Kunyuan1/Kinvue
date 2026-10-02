import { baselineWindow } from '../baseline'
import type {
  Assessment,
  BaselineSpan,
  CheckInAnswers,
  FiredRule,
  SessionRecord,
  UncomparedMetric,
  Vitals,
} from '../session/types'
import { unusableReason } from '../session/usable'

/**
 * What may leave the device: the one place it is decided (KV-37).
 *
 * The policy is KV-32's (ARCHITECTURE.md, "What leaves the device"); this is
 * that policy as code, and sync sends what `toShared` returns and nothing else
 * (#39, #41). It is read in a minute on purpose: a privacy boundary scattered
 * across serialisers and handlers is one nobody can check.
 *
 * **Every field is classified, and the tables do the copying.** Each shape that
 * leaves has a table typed over its own keys, so a field added to the record —
 * or to its vitals, answers, assessment, fired rules, uncompared metrics or
 * baseline span — does not compile until it is decided here. And a field is
 * copied only because its table says `shared`, so the table cannot say one
 * thing while the code does another. Anything a record carries that no table
 * names — a hand-edited store, a field from a newer client — is left behind.
 */

/** How one field is treated on the way out. */
export type Sharing =
  /** Leaves as it is. */
  | 'shared'
  /** Never leaves: not needed, so not sent. */
  | 'withheld'
  /** Leaves, but as something else: the share's own id in place of the local one. */
  | 'replaced'
  /** Leaves only to a viewer the person turned it on for. */
  | 'per-viewer'
  /** Marks a record that never leaves at all. */
  | 'never'

/** A table over every key of `T`, optional ones included. */
type Policy<T> = { readonly [K in keyof Required<T>]: Sharing }

export const RECORD_POLICY: Policy<SessionRecord> = {
  id: 'shared',
  personId: 'replaced',
  capturedAt: 'shared',
  timeZone: 'shared',
  vitals: 'shared',
  answers: 'shared',
  assessment: 'shared',
  seeded: 'never',
}

export const VITALS_POLICY: Policy<Vitals> = {
  pulseRateBpm: 'shared',
  breathingRateBrpm: 'shared',
  hrvRmssdMs: 'shared',
  // Nothing reads it — no rule, no screen.
  hrvSdnnMs: 'withheld',
  // Quality, not personal: without them a viewer cannot tell "not enough to
  // say" from a reading.
  confidence: 'shared',
  stable: 'shared',
  durationSec: 'shared',
}

export const ANSWERS_POLICY: Policy<CheckInAnswers> = {
  mood: 'shared',
  sleep: 'shared',
  // Whichever the record carries: the same answer, asked two ways (KV-16).
  skippedMeal: 'shared',
  eatenToday: 'shared',
  painReported: 'shared',
  // The only text in the person's own words.
  painNote: 'per-viewer',
}

export const ASSESSMENT_POLICY: Policy<Assessment> = {
  flag: 'shared',
  summary: 'shared',
  firedRules: 'shared',
  baselineSessions: 'shared',
  baselineSeededSessions: 'shared',
  baselineRefusedSessions: 'shared',
  baselineSpan: 'shared',
  uncomparedMetrics: 'shared',
  withheld: 'shared',
}

export const FIRED_RULE_POLICY: Policy<FiredRule> = {
  id: 'shared',
  title: 'shared',
  explanation: 'shared',
  // Orders the rules; never shown as a score (#42).
  severity: 'shared',
}

export const UNCOMPARED_POLICY: Policy<UncomparedMetric> = {
  metric: 'shared',
  readings: 'shared',
  needed: 'shared',
  mean: 'shared',
}

export const BASELINE_SPAN_POLICY: Policy<BaselineSpan> = {
  from: 'shared',
  to: 'shared',
}

/** The vitals as they leave: `hrvSdnnMs` is absent, not set to anything. */
export type SharedVitals = Omit<Vitals, 'hrvSdnnMs'>

/** One check-in as a viewer's device receives it. */
export interface SharedRecord {
  id: string
  /** The share's own opaque id, never the local one (KV-32). */
  personId: string
  capturedAt: string
  timeZone?: string
  vitals: SharedVitals
  answers: CheckInAnswers
  assessment?: Assessment
}

/** Who a record is being prepared for. */
export interface Viewer {
  /** The opaque id this person is known by in this share. */
  shareId: string
  /** Whether the person has turned the pain note on for this viewer (KV-31). */
  painNote: boolean
}

/**
 * The fields of `source` its table calls `shared`, and only those. A value
 * that is absent stays absent: `undefined` is never written in its place.
 */
function pickShared<T extends object>(source: T, policy: Policy<T>): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(policy) as (keyof T)[]) {
    if (policy[key as keyof Required<T>] !== 'shared') continue
    if (!Object.hasOwn(source, key) || source[key] === undefined) continue
    out[key] = source[key]
  }
  return out
}

function sharedAssessment(assessment: Assessment): Assessment {
  const out = pickShared(assessment, ASSESSMENT_POLICY)
  if (out.firedRules !== undefined) {
    out.firedRules = out.firedRules.map((rule) => pickShared(rule, FIRED_RULE_POLICY) as FiredRule)
  }
  if (out.uncomparedMetrics !== undefined) {
    out.uncomparedMetrics = out.uncomparedMetrics.map(
      (gap) => pickShared(gap, UNCOMPARED_POLICY) as UncomparedMetric,
    )
  }
  if (out.baselineSpan !== undefined) {
    out.baselineSpan = pickShared(out.baselineSpan, BASELINE_SPAN_POLICY) as BaselineSpan
  }
  return out as Assessment
}

/**
 * `record` as it may leave the device for `viewer`, or null when it may not
 * leave at all — a seeded record, demo data about nobody, whose ids repeat
 * across installs.
 *
 * A real check-in scored against seeded days is shared like any other: its
 * stored verdict already says it was compared with demo data, and holding back
 * a real check-in would be the wrong way round (KV-32's open question).
 */
export function toShared(record: SessionRecord, viewer: Viewer): SharedRecord | null {
  if (record.seeded === true) return null
  const answers = pickShared(record.answers, ANSWERS_POLICY) as CheckInAnswers
  if (viewer.painNote && record.answers.painNote !== undefined) {
    answers.painNote = record.answers.painNote
  }
  const shared: SharedRecord = {
    id: record.id,
    personId: viewer.shareId,
    capturedAt: record.capturedAt,
    vitals: pickShared(record.vitals, VITALS_POLICY) as SharedVitals,
    answers,
  }
  if (record.timeZone !== undefined) shared.timeZone = record.timeZone
  if (record.assessment !== undefined) shared.assessment = sharedAssessment(record.assessment)
  return shared
}

/**
 * The date a new viewer's history reaches back to: the earliest check-in
 * behind the current usual — the one the latest check-in was compared against
 * — or the latest check-in itself while there is no usual yet. Null with no
 * usable check-in at all, when a viewer starts from approval onward. Shown to
 * the person when they approve, as the actual date (KV-32): the usual counts
 * 14 usable check-ins, not 14 days, so it can reach back weeks.
 */
export function shareSetStart(records: readonly SessionRecord[], personId: string): string | null {
  const theirs = records
    .filter((r) => r.personId === personId)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const usable = theirs.filter((r) => unusableReason(r.vitals) === null)
  const latest = usable.at(-1)
  if (latest === undefined) return null
  const behind = baselineWindow(theirs.filter((r) => r.capturedAt < latest.capturedAt))
  return (behind[0] ?? latest).capturedAt
}

/**
 * The records a new viewer is sent: every one of this person's check-ins from
 * `shareSetStart` onward, refused captures included — the chart's and the
 * cards' caveats are counted from them (KV-12, KV-100), and a viewer shown
 * fewer would be more confident than the check-in device. Seeded records are
 * left out, as `toShared` would refuse them anyway.
 */
export function shareSet(records: readonly SessionRecord[], personId: string): SessionRecord[] {
  const start = shareSetStart(records, personId)
  if (start === null) return []
  return records
    .filter((r) => r.personId === personId && r.seeded !== true && r.capturedAt >= start)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
}
