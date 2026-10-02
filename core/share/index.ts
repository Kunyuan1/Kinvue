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
 * baseline span — does not compile until it is decided here. A field holding a
 * shape of its own is classified by that shape's table, never as `shared`
 * whole, and one walk (`pick`) copies a record by reading the tables from
 * `RECORD_POLICY` down: a field leaves only because its table says `shared`,
 * so the table cannot say one thing while the code does another (review of
 * #180, which found the record's own table read by nothing). Anything a record
 * carries that no table names — a hand-edited store, a field from a newer
 * client — is left behind.
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

/**
 * How one field is treated. A field holding a shape, or a list of them, takes
 * that shape's own table, or a `Sharing` other than `shared`: copied whole,
 * whatever it held would leave with it, decided by nobody.
 */
type Entry<V> = [NonNullable<V>] extends [readonly (infer E)[]]
  ? E extends object
    ? Policy<E> | Exclude<Sharing, 'shared'>
    : Sharing
  : [NonNullable<V>] extends [object]
    ? Policy<NonNullable<V>> | Exclude<Sharing, 'shared'>
    : Sharing

/**
 * A table over every key of `T`, optional ones included — and, for a union
 * like `CheckInAnswers`, the keys of every member. `keyof (A | B)` is only the
 * keys they share, so a field added to one branch alone would otherwise need
 * no entry, and be dropped without a word (review of #180).
 */
export type Policy<T> = { readonly [K in AnyKey<T>]-?: Entry<ValueAt<T, K>> }

/** Every key of any member of `T`. */
type AnyKey<T> = T extends unknown ? keyof T : never

/** The value at `K` in whichever members of `T` have it. */
type ValueAt<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never

export const VITALS_POLICY = {
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
} as const satisfies Policy<Vitals>

export const ANSWERS_POLICY = {
  mood: 'shared',
  sleep: 'shared',
  // Whichever the record carries: the same answer, asked two ways (KV-16).
  skippedMeal: 'shared',
  eatenToday: 'shared',
  painReported: 'shared',
  // The only text in the person's own words.
  painNote: 'per-viewer',
} as const satisfies Policy<CheckInAnswers>

export const FIRED_RULE_POLICY = {
  id: 'shared',
  title: 'shared',
  explanation: 'shared',
  // Orders the rules; never shown as a score (#42).
  severity: 'shared',
} as const satisfies Policy<FiredRule>

export const UNCOMPARED_POLICY = {
  metric: 'shared',
  readings: 'shared',
  needed: 'shared',
  mean: 'shared',
} as const satisfies Policy<UncomparedMetric>

export const BASELINE_SPAN_POLICY = {
  from: 'shared',
  to: 'shared',
} as const satisfies Policy<BaselineSpan>

export const ASSESSMENT_POLICY = {
  flag: 'shared',
  summary: 'shared',
  firedRules: FIRED_RULE_POLICY,
  baselineSessions: 'shared',
  baselineSeededSessions: 'shared',
  baselineRefusedSessions: 'shared',
  baselineSpan: BASELINE_SPAN_POLICY,
  uncomparedMetrics: UNCOMPARED_POLICY,
  withheld: 'shared',
} as const satisfies Policy<Assessment>

export const RECORD_POLICY = {
  // Not replaced like `personId` (review of #180): a real record's id is a
  // random UUID (#25), so it names nothing and correlates nothing across
  // installs. The ids that do — `seed-demo-margaret-3` — are on seeded records,
  // which never leave. And updates and removals travel by it (#45).
  id: 'shared',
  personId: 'replaced',
  capturedAt: 'shared',
  timeZone: 'shared',
  vitals: VITALS_POLICY,
  answers: ANSWERS_POLICY,
  assessment: ASSESSMENT_POLICY,
  seeded: 'never',
} as const satisfies Policy<SessionRecord>

/**
 * `T` as its table `P` lets it leave: each field it calls `shared`, keeping its
 * own optionality; each field with a table of its own, as that table lets it
 * leave; and each `per-viewer` field, optional, since a viewer may not have it.
 * Read off the tables rather than written out beside them, so the type cannot
 * keep promising a field the table has stopped sending (review of #180).
 */
type SharedOf<T, P> = T extends unknown
  ? {
      [K in keyof T as Entered<K, P> extends 'shared' | object ? K : never]: SharedValue<
        T[K],
        Entered<K, P>
      >
    } & {
      [K in keyof T as Entered<K, P> extends 'per-viewer' ? K : never]?: T[K]
    }
  : never

/** The entry `P` gives `K`, or `never` for a key it does not name. */
type Entered<K, P> = K extends keyof P ? P[K] : never

/** One value as its entry lets it leave: as itself, or rebuilt by its own table. */
type SharedValue<V, P> = P extends 'shared'
  ? V
  : V extends readonly (infer E)[]
    ? SharedOf<E, P>[]
    : V extends object
      ? SharedOf<V, P>
      : V

/** One check-in as a viewer's device receives it. */
export type SharedRecord = SharedOf<SessionRecord, typeof RECORD_POLICY> & {
  /** The share's own opaque id, never the local one (KV-32). */
  personId: string
}

/** The vitals as they leave: `hrvSdnnMs` is absent, not set to anything. */
export type SharedVitals = SharedRecord['vitals']

/** Who a record is being prepared for. */
export interface Viewer {
  /** The opaque id this person is known by in this share. */
  shareId: string
  /** Whether the person has turned the pain note on for this viewer (KV-31). */
  painNote: boolean
}

/** A table as `pick` walks it: every entry a `Sharing` or a table of its own. */
type AnyPolicy = { readonly [key: string]: Sharing | AnyPolicy }

/**
 * `source` as its table lets it leave, walked from `RECORD_POLICY` down. A
 * `shared` field is copied; a field with a table of its own is rebuilt from
 * that table, element by element for a list, so nothing under it is shared
 * with the record; a `per-viewer` field is copied when the viewer has turned
 * it on. Nothing else leaves. A value that is absent stays absent: `undefined`
 * is never written in its place. A shape that is not one where its table
 * expects one — a hand-edited store — is left behind rather than copied.
 */
function pick(source: object, policy: AnyPolicy, viewer: Viewer): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(policy)) {
    if (!Object.hasOwn(source, key)) continue
    const value: unknown = (source as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (typeof entry === 'object') {
      if (Array.isArray(value)) {
        out[key] = value.filter(isShape).map((item) => pick(item, entry, viewer))
      } else if (isShape(value)) {
        out[key] = pick(value, entry, viewer)
      }
    } else if (entry === 'shared' || (entry === 'per-viewer' && granted(viewer, key))) {
      out[key] = value
    }
  }
  return out
}

const isShape = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether `viewer` has been given a `per-viewer` field: a grant of the same
 * name, set to true. The pain note is the only one (KV-31).
 */
const granted = (viewer: Viewer, key: string): boolean =>
  (viewer as unknown as Record<string, unknown>)[key] === true

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
  // `personId` is `replaced`, so `pick` leaves it behind and it is written here.
  const picked = pick(record, RECORD_POLICY, viewer) as Omit<SharedRecord, 'personId'>
  return { ...picked, personId: viewer.shareId }
}

/**
 * The records a new viewer is sent, oldest first, before `toShared`: this
 * person's real check-ins, refused captures included, from the earliest of
 * those the latest usable check-in was scored against. That is the window it
 * was compared with or, while the usual was still being learned (fewer than
 * `MIN_BASELINE_SESSIONS`), the check-ins it was counted against, since its
 * card quotes that count (KV-100). Only with no usable check-in before it does
 * the share begin at the latest itself (review of #180: this used to say "while
 * there is no usual yet", which is narrower than the code).
 *
 * The one place the share set is chosen, so `shareSet` and `shareSetStart`
 * cannot disagree (review of #180). Seeded days count toward the usual, as
 * they did when the latest check-in was scored, but are never sent: they set
 * how far back the share reaches, never where what is sent begins.
 */
function toBeSent(records: readonly SessionRecord[], personId: string): SessionRecord[] {
  const theirs = records
    .filter((r) => r.personId === personId)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const latest = theirs.filter((r) => unusableReason(r.vitals) === null).at(-1)
  if (latest === undefined) return []
  const behind = baselineWindow(theirs.filter((r) => r.capturedAt < latest.capturedAt))
  const reach = (behind[0] ?? latest).capturedAt
  return theirs.filter((r) => r.seeded !== true && r.capturedAt >= reach)
}

/**
 * The date a new viewer's history begins: the first check-in they will
 * actually be sent. Shown to the person when they approve, as the actual date
 * (KV-32): the usual counts 14 usable check-ins, not 14 days, so it can reach
 * back weeks.
 *
 * **Read off what is sent, not off the usual** (review of #180). It used to be
 * the earliest check-in behind the usual, seeded ones included, so on a demo
 * install the person was told a share reached back to an invented August day
 * when the first real check-in it would send was in September — and with only
 * seeded days, a share "reaching back to August" sent nothing at all.
 *
 * Null when nothing would be sent — no usable check-in, or none that is real —
 * and a viewer then starts from approval onward.
 */
export function shareSetStart(records: readonly SessionRecord[], personId: string): string | null {
  return toBeSent(records, personId)[0]?.capturedAt ?? null
}

/**
 * What a new viewer is sent, as it leaves: this person's real check-ins from
 * `shareSetStart` onward, refused captures included — the chart's and the
 * cards' caveats are counted from them (KV-12, KV-100), and a viewer shown
 * fewer would be more confident than the check-in device.
 *
 * **Each one through `toShared`, for this viewer** (review of #180). It used to
 * return the records themselves, so the obvious line for the outbox (#41) —
 * sending what this returns — would have sent the local person id, the
 * withheld HRV and every pain note. Now it cannot be used to send anything
 * else.
 */
export function shareSet(
  records: readonly SessionRecord[],
  personId: string,
  viewer: Viewer,
): SharedRecord[] {
  return toBeSent(records, personId)
    .map((r) => toShared(r, viewer))
    .filter((r): r is SharedRecord => r !== null)
}
