import { checkFormat, RECORD_FORMAT } from './format'
import type {
  Assessment,
  BaselineSpan,
  CheckInAnswers,
  ComparedMetric,
  Flag,
  FiredRule,
  MoodAnswer,
  SessionRecord,
  SleepAnswer,
  Tombstone,
  UncomparedMetric,
  Vitals,
  WithheldReason,
} from './types'

/**
 * Every field of a record read, checked against its type (KV-181).
 *
 * A record read from disk, or arriving from another device, is whatever the
 * JSON said: `store.ts` parses it, and until this checked only its format
 * (KV-30). The readers were made defensive one by one instead — `unusableReason`
 * reads every number as `!(x >= n)`, `describeAnswers` reads an unknown value as
 * "not recorded". That holds while this app is the only writer. It does not once
 * records come from another device, where a signature (KV-33) proves who sent a
 * record and not that it is well formed.
 *
 * **It checks, and never repairs.** A record either is what its type says or is
 * refused, with the first reason, as `parseCheckInAnswers` refuses malformed
 * answers. What a refusal does is each reader's to decide (ARCHITECTURE.md,
 * KV-181): the check-in device refuses its whole file; a viewer holds the one
 * record aside.
 *
 * **Every shape the store has ever written passes.** Each field added since the
 * first commit is optional, and the one required field that changed widened
 * (`confidence`, KV-12), so the types today describe every record ever stored.
 * Fields this build does not know are allowed and left alone: adding one does
 * not change the format (KV-30), so a newer record may carry one.
 *
 * **One spec per shape, typed over its keys**, as the share tables are: a field
 * added to a shape does not compile until it has a check here, a field cannot
 * be checked as optional when its type requires it, or the reverse, and each
 * takes the check its type calls for (`FieldFor`) — a shape's own spec, a list
 * of its item's — not merely some check.
 *
 * **Types, not ranges** (review of #183). This says a field is a number, not
 * that the number is sensible: `confidence` is 0..1 by convention, and a sender
 * that skipped the SDK's percentage conversion (`app/main/vitals.ts`) would send
 * 95 and pass — then clear `unusableReason`'s 0.5 as a fully vouched-for
 * reading, the reassuring direction. The same goes for a severity outside 0..1
 * or a negative count. Ranges stay with whoever produces the value (the
 * capture's conversion, the scorer) and whoever leans on one: a reader that
 * needs a range checks it itself rather than assuming this did. Deliberate:
 * which ranges are right is a question about the data, not about its shape,
 * and a check that guessed at one could refuse a real history.
 */

/** Why a value is not what its field holds, or null when it is. */
export type Check = (value: unknown, at: string) => string | null

/** A field holding one shape, checked field by field by `shape`, then as a whole by `also`. */
export interface Nested<S = AnySpec> {
  readonly shape: S
  readonly also?: (value: Record<string, unknown>, at: string) => string | null
}

/** A field holding a list, every item of which is the shape `listOf` describes. */
export interface ListOf<S = AnySpec> {
  readonly listOf: S
}

export type Field = Check | Nested | ListOf

/**
 * A field that may be absent. Absent is the only way to be absent: a `null`
 * where the type says the field may be missing is a value, and is checked as
 * one — and refused unless the field can hold `null` (KV-30's rule for formats).
 */
export interface Optional<F = Field> {
  readonly optional: F
}

export type Entry = Field | Optional

/** A spec as the walkers read it. */
export type AnySpec = { readonly [key: string]: Entry }

/** Every key of any member of `T`, as `Policy` takes them in `core/share`. */
type AnyKey<T> = T extends unknown ? keyof T : never

/** Whether `K` may be missing from some member of `T`. */
type MayBeMissing<T, K extends PropertyKey> = true extends MissingIn<T, K> ? true : false

/** For each member of `T`, whether `K` may be missing from it. */
type MissingIn<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? object extends Pick<T, K>
      ? true
      : false
    : true
  : never

/** The value at `K` in whichever members of `T` have it. */
type ValueAt<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never

/** The members of `V` that are shapes. */
type Shapes<V> = Extract<NonNullable<V>, object>

/**
 * The check a field of type `V` takes: a `Check` for a plain value, a spec of
 * *that* shape for one, and a spec of its item for a list (review of #183). So
 * vitals cannot be checked as answers, a list as one shape, or a shape by a
 * check that looks at nothing under it — the type decides, as `Entry` does for
 * the share tables, not only that the field has a check.
 */
export type FieldFor<V> = [Shapes<V>] extends [never]
  ? Check
  : [Shapes<V>] extends [readonly (infer E)[]]
    ? [Extract<E, object>] extends [never]
      ? Check
      : ListOf<Spec<Extract<E, object>>>
    : Nested<Spec<Shapes<V>>>

/**
 * A spec for `T`: every key, optional exactly where `T` lets the field be
 * missing, and each with the check its type calls for (`FieldFor`).
 */
export type Spec<T> = {
  readonly [K in AnyKey<T>]-?: MayBeMissing<T, K> extends true
    ? Optional<FieldFor<ValueAt<T, K>>>
    : FieldFor<ValueAt<T, K>>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optional = <F extends Field>(field: F): Optional<F> => ({ optional: field })
const nested = <S extends AnySpec>(shape: S, also?: Nested['also']): Nested<S> =>
  also === undefined ? { shape } : { shape, also }
const listOf = <S extends AnySpec>(shape: S): ListOf<S> => ({ listOf: shape })

const number: Check = (v, at) =>
  typeof v === 'number' && Number.isFinite(v) ? null : `${at} is not a number`
const nullableNumber: Check = (v, at) => (v === null ? null : number(v, at))
const boolean: Check = (v, at) => (typeof v === 'boolean' ? null : `${at} is not true or false`)
const string: Check = (v, at) => (typeof v === 'string' ? null : `${at} is not text`)
/**
 * An id: text, not empty, and with no space around it, since updates and
 * removals travel by it (#45) and ids are matched exactly — `' share-1'` would
 * be another id that looks the same (review of #183; `parsePersonId`'s rule).
 */
const id: Check = (v, at) =>
  typeof v === 'string' && v !== '' && v.trim() === v ? null : `${at} is not an id`
/**
 * A moment, written exactly as `toISOString` writes one — the only way this
 * app has ever written a time — and naming a real one. Not merely something
 * `Date.parse` accepts (review of #183): it takes `'1'` and `'09/15/2026'`,
 * and every reader compares these as text — the store's sort, the share set's
 * reach, `sameRecord` — which orders them as time only when every one is this
 * same fixed-width UTC form.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const isInstant = (v: unknown): v is string =>
  typeof v === 'string' && ISO_INSTANT.test(v) && new Date(v).toISOString() === v
const instant: Check = (v, at) => (isInstant(v) ? null : `${at} is not a time`)
/**
 * A format that is there. `checkFormat` reads an absent one as 1, which is
 * right for a record and wrong for this check, which only runs on a format
 * that is present — so `undefined` is refused here rather than left to the
 * caller to have filtered out (review of #183).
 */
const format: Check = (v, at) =>
  v === undefined || checkFormat({ format: v }) === 'unrecognised'
    ? `${at} is not a record format`
    : null
const oneOf =
  <T extends string>(values: readonly T[]): Check =>
  (v, at) =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
      ? null
      : `${at} is not one of ${values.join(', ')}`

const MOODS: readonly MoodAnswer[] = ['good', 'ok', 'low']
const SLEEPS: readonly SleepAnswer[] = ['well', 'ok', 'poorly']
const FLAGS: readonly Flag[] = ['normal', 'elevated', 'insufficient-signal']
const METRICS: readonly ComparedMetric[] = ['pulse', 'breathing', 'hrv']
const WITHHELD: readonly WithheldReason[] = [
  'nothing-measured',
  'too-short',
  'unrated',
  'low-confidence',
  'still-learning',
  'uncompared',
]

export const VITALS_SPEC: Spec<Vitals> = {
  pulseRateBpm: nullableNumber,
  breathingRateBrpm: nullableNumber,
  hrvRmssdMs: nullableNumber,
  hrvSdnnMs: nullableNumber,
  // A number on every record before KV-12, and a number or null since.
  confidence: nullableNumber,
  stable: boolean,
  durationSec: number,
}

export const ANSWERS_SPEC: Spec<CheckInAnswers> = {
  mood: oneOf(MOODS),
  sleep: oneOf(SLEEPS),
  // Each is missing on one branch of the union; `mealAnswered` checks that
  // exactly one of the two is there (KV-16).
  skippedMeal: optional(boolean),
  eatenToday: optional(boolean),
  painReported: boolean,
  painNote: optional(string),
}

export const FIRED_RULE_SPEC: Spec<FiredRule> = {
  // Any text, not today's rule ids: a card keeps the rules it was given,
  // including ones the engine no longer has (KV-138).
  id: string,
  title: string,
  explanation: string,
  severity: number,
}

export const UNCOMPARED_SPEC: Spec<UncomparedMetric> = {
  metric: oneOf(METRICS),
  readings: number,
  needed: number,
  mean: optional(number),
}

export const BASELINE_SPAN_SPEC: Spec<BaselineSpan> = {
  from: instant,
  to: instant,
}

export const ASSESSMENT_SPEC: Spec<Assessment> = {
  flag: oneOf(FLAGS),
  firedRules: listOf(FIRED_RULE_SPEC),
  summary: string,
  baselineSessions: number,
  baselineSeededSessions: optional(number),
  baselineRefusedSessions: optional(number),
  baselineSpan: optional(nested(BASELINE_SPAN_SPEC)),
  uncomparedMetrics: optional(listOf(UNCOMPARED_SPEC)),
  withheld: optional(oneOf(WITHHELD)),
  rulesVersion: optional(number),
}

/** The meal question, asked one of two ways: exactly one answer, never both (KV-16). */
export function mealAnswered(answers: Record<string, unknown>, at: string): string | null {
  const asked = ['skippedMeal', 'eatenToday'].filter((key) => answers[key] !== undefined)
  if (asked.length === 1) return null
  return asked.length === 0
    ? `the meal question has no answer in ${at}`
    : `the meal question is answered both ways in ${at}`
}

export const RECORD_SPEC: Spec<SessionRecord> = {
  format: optional(format),
  id,
  personId: id,
  capturedAt: instant,
  timeZone: optional(string),
  vitals: nested(VITALS_SPEC),
  answers: nested(ANSWERS_SPEC, mealAnswered),
  assessment: optional(nested(ASSESSMENT_SPEC)),
  seeded: optional(boolean),
}

/** Whether `entry` lets its field be missing. */
export const isOptional = (entry: Entry): entry is Optional =>
  typeof entry === 'object' && 'optional' in entry

/** Whether `value` holds `key`: present, and not `undefined`, which JSON cannot say. */
export const holds = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key) && value[key] !== undefined

/** Why `value` is not what `field` holds, or null. */
export function checkField(field: Field, value: unknown, at: string): string | null {
  if (typeof field === 'function') return field(value, at)
  if ('listOf' in field) {
    if (!Array.isArray(value)) return `${at} is not a list`
    for (const [i, item] of value.entries()) {
      const why = checkShape(field.listOf, item, `${at}[${String(i)}]`)
      if (why !== null) return why
    }
    return null
  }
  return checkShape(field.shape, value, at, field.also)
}

/**
 * Why `value` is not the shape `spec` describes, or null. Fields the spec does
 * not name are left alone.
 */
export function checkShape(
  spec: AnySpec,
  value: unknown,
  at: string,
  also?: Nested['also'],
): string | null {
  if (!isObject(value)) return `${at === '' ? 'it' : at} is not a group of fields`
  for (const [key, entry] of Object.entries(spec)) {
    const here = at === '' ? key : `${at}.${key}`
    const present = holds(value, key)
    if (isOptional(entry)) {
      if (!present) continue
      const why = checkField(entry.optional, value[key], here)
      if (why !== null) return why
    } else {
      if (!present) return `${here} is missing`
      const why = checkField(entry, value[key], here)
      if (why !== null) return why
    }
  }
  return also === undefined ? null : also(value, at === '' ? 'it' : at)
}

/** The reason given for an entry that is not a record at all. */
export const NOT_A_RECORD = 'it is not a check-in at all'

/**
 * Why `value` is not a check-in this build can read, or null when it is one.
 *
 * Its format first, before anything else about it is trusted (KV-30): a record
 * from a newer format may differ in ways no check here knows. Then every field.
 * The reason names the field — `vitals.durationSec is not a number` — for
 * whoever has to look at the file.
 */
export function checkRecord(value: unknown): string | null {
  if (!isObject(value)) return NOT_A_RECORD
  if (checkFormat(value) === 'newer') {
    const said = String(value.format)
    return `it is in a newer format (${said}) than this app reads (${String(RECORD_FORMAT)})`
  }
  return checkShape(RECORD_SPEC, value, '')
}

export const TOMBSTONE_SPEC: Spec<Tombstone> = {
  id,
  personId: id,
  removedAt: instant,
}

/** Why `value` is not a deletion record (KV-21), or null when it is one. */
export function checkTombstone(value: unknown): string | null {
  if (!isObject(value)) return 'it is not a record of a deletion'
  return checkShape(TOMBSTONE_SPEC, value, '')
}
