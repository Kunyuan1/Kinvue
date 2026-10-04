import { baselineWindow } from '../baseline'
import {
  checkField,
  checkRecord,
  holds,
  isOptional,
  NOT_A_RECORD,
  RECORD_SPEC,
  type AnySpec,
  type Field,
  type Nested,
} from '../session/check'
import { checkFormat, formatOf, RECORD_FORMAT } from '../session/format'
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
 * baseline span — does not compile until it is decided here. A field that can
 * hold a shape is classified by that shape's table, or a list of it, never as
 * `shared` or `per-viewer` whole, and one walk (`pick`) copies a record by
 * reading the tables from `RECORD_POLICY` down — `never` included: a field
 * leaves only because its table says so, so the table cannot say one thing
 * while the code does another (two reviews of #180). Anything a record carries
 * that no table names — a hand-edited store, a field from a newer client — is
 * left behind; a record that is not what its tables describe does not leave.
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
  /**
   * Never leaves, and when it is true, neither does the record holding it, at
   * any depth: `seeded` is why a demo day stays home. Only for a true/false
   * field, where "true" has a meaning.
   */
  | 'never'

/**
 * How one field is treated. A field holding a shape, or a list of them, takes
 * that shape's own table, or `withheld`: anything else — `shared`, or
 * `per-viewer` once granted — would copy it whole, and whatever it held would
 * leave with it, decided by nobody (second review of #180).
 */
type Entry<V> = [Shapes<V>] extends [never]
  ? Leaf<V>
  : [Shapes<V>] extends [readonly (infer E)[]]
    ? [Extract<E, object>] extends [never]
      ? Leaf<V>
      : ListPolicy<Policy<Extract<E, object>>> | 'withheld'
    : Policy<Shapes<V>> | 'withheld'

/**
 * How a plain field may be treated. `never` only on a true/false field, where
 * "true" means something; `per-viewer` only on a field a record can be without
 * (KV-181), since a viewer not given it receives the record without it — so
 * the shared type, `checkShared` and the field's own type all agree it may be
 * missing.
 */
type Leaf<V> = Exclude<
  Sharing,
  ([NonNullable<V>] extends [boolean] ? never : 'never') |
    (undefined extends V ? never : 'per-viewer')
>

/**
 * The members of `V` that are shapes. Asked of every member, not of `V` whole:
 * `string | Clip` is not an object, so asking "is it one?" let `shared` copy
 * the `Clip` (second review of #180). A field that can hold a shape at all is
 * decided by a table, and its plain members do not leave through it.
 */
type Shapes<V> = Extract<NonNullable<V>, object>

const LIST: unique symbol = Symbol('list')

/**
 * A list of shapes, each decided by `policy`. Its own kind of entry, not the
 * table itself, so `pick` knows which it expects: a list arriving where one
 * shape belongs, or one shape where a list does, is not sent as though it were
 * the other (second review of #180). Keyed by a symbol, so no field name can
 * be mistaken for it.
 */
export interface ListPolicy<P> {
  readonly [LIST]: P
}

/** The entry for a field holding a list of shapes, each decided by `policy`. */
export const listOf = <P>(policy: P): ListPolicy<P> => ({ [LIST]: policy })

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
  firedRules: listOf(FIRED_RULE_POLICY),
  baselineSessions: 'shared',
  baselineSeededSessions: 'shared',
  baselineRefusedSessions: 'shared',
  baselineSpan: BASELINE_SPAN_POLICY,
  uncomparedMetrics: listOf(UNCOMPARED_POLICY),
  // The stored reason a verdict was withheld (KV-138), not a classification:
  // the card says it, so it leaves.
  withheld: 'shared',
  // So a viewer, which never rescores, can tell a verdict from rules the app
  // no longer has (KV-30).
  rulesVersion: 'shared',
} as const satisfies Policy<Assessment>

export const RECORD_POLICY = {
  // What a viewer checks before reading anything else (KV-30). Always written
  // on the way out, as 1 for a record from before it said so.
  format: 'shared',
  // Not replaced like `personId` (review of #180): a real record's id is a
  // random UUID (#25), so it names nothing and correlates nothing across
  // installs. The ids that do — `seed-demo-margaret-3` — are on seeded records,
  // which never leave. And updates and removals travel by it (#45).
  id: 'shared',
  personId: 'replaced',
  capturedAt: 'shared',
  // Names a region, and over time shows travel — the cost KV-32 accepted, since
  // a viewer elsewhere needs the person's own day, not theirs (KV-28).
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

/**
 * One value as its entry lets it leave: as itself, or rebuilt by its own table
 * — which sends only the shape members of a mixed union, so only they are on
 * the type.
 */
type SharedValue<V, P> = P extends 'shared'
  ? V
  : P extends ListPolicy<infer Q>
    ? NonNullable<V> extends readonly (infer E)[]
      ? SharedOf<Extract<E, object>, Q>[] | Extract<V, undefined>
      : never
    : SharedOf<Shapes<V>, P> | Extract<V, undefined>

/** One check-in as a viewer's device receives it. */
export type SharedRecord = SharedOf<SessionRecord, typeof RECORD_POLICY> & {
  /** Always present: a record that leaves says which format it is in (KV-30). */
  format: number
  /** The share's own opaque id, never the local one (KV-32). */
  personId: string
}

/**
 * Who a record is being prepared for: the opaque id this person is known by in
 * this share, and, for every field a table sends `per-viewer`, whether the
 * person has turned it on for this viewer (KV-31) — today only `painNote`.
 *
 * **Those fields are read off the tables** (second review of #180), so a new
 * `per-viewer` entry does not compile until every viewer says whether it has
 * it. Written out by hand, the entry could exist with nothing to grant it: it
 * would never be sent, while the shared type and a consent screen offered it.
 */
export type Viewer = { shareId: string } & {
  readonly [K in PerViewerKey<typeof RECORD_POLICY> & string]: boolean
}

/** Every field some table under `P` sends only to a viewer given it. */
type PerViewerKey<P> =
  P extends ListPolicy<infer Q>
    ? PerViewerKey<Q>
    : P extends object
      ? { [K in keyof P]: P[K] extends 'per-viewer' ? K : PerViewerKey<P[K]> }[keyof P]
      : never

/** A table as `pick` walks it: every entry a `Sharing`, a table, or a list of one. */
type AnyPolicy = { readonly [key: string]: Sharing | AnyPolicy | ListPolicy<AnyPolicy> }

/** What `pick` gives back for a record it cannot send as its tables describe. */
const REFUSED = null

/**
 * `source` as its table lets it leave, walked from `RECORD_POLICY` down. A
 * `shared` field is copied; a field with a table of its own is rebuilt from
 * that table, element by element for a list, so nothing under it is shared
 * with the record; a `per-viewer` field is copied when the viewer has turned
 * it on. Nothing else leaves. A value that is absent stays absent: `undefined`
 * is never written in its place. A shape that is not one where its table
 * expects one — a hand-edited store — is left behind rather than copied.
 */
function pick(
  source: object,
  policy: AnyPolicy,
  viewer: Viewer | null,
): Record<string, unknown> | typeof REFUSED {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(policy)) {
    if (!Object.hasOwn(source, key)) continue
    const value: unknown = (source as Record<string, unknown>)[key]
    if (value === undefined) continue
    // Read from the table, so marking a field `never` keeps its record home
    // with no second rule to keep in step (second review of #180).
    if (entry === 'never') {
      if (value === true) return REFUSED
      continue
    }
    if (typeof entry === 'object' && LIST in entry) {
      // A list where its table expects one: anything else refuses the record.
      if (!Array.isArray(value)) return REFUSED
      // Every item, or the record does not leave: a list quietly shortened —
      // three fired rules arriving as two — would send a verdict that its own
      // evidence no longer explains (second review of #180).
      const items = value.map((item) => (isShape(item) ? pick(item, entry[LIST], viewer) : REFUSED))
      if (items.includes(REFUSED)) return REFUSED
      out[key] = items
    } else if (typeof entry === 'object') {
      // One shape where its table expects one: a list, or a plain value,
      // refuses the record rather than arriving as something it is typed not to be.
      if (!isShape(value)) return REFUSED
      const shape = pick(value, entry, viewer)
      if (shape === REFUSED) return REFUSED
      out[key] = shape
    } else if (entry === 'shared' || entry === 'per-viewer') {
      // A leaf leaves only as a plain value. An object where its table expects
      // one — a hand-edited store — would leave whole, decided by nobody, and
      // leaving it behind would send a record missing a field it is typed to have.
      // Checked whether or not this viewer is sent it, so whether a record may
      // leave is the same for every viewer.
      if (!isPlain(value)) return REFUSED
      if (entry === 'per-viewer' && !granted(viewer, key)) continue
      out[key] = Array.isArray(value) ? [...value] : value
    }
  }
  return out
}

/** A string, number, boolean or null — or a list of only those, which is copied. */
const isPlain = (value: unknown): boolean =>
  value === null ||
  ['string', 'number', 'boolean'].includes(typeof value) ||
  (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object'))

const isShape = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether `viewer` has been given a `per-viewer` field: its grant of the same
 * name, which `Viewer` is made to carry for every such field.
 */
const granted = (viewer: Viewer | null, key: string): boolean =>
  viewer !== null && (viewer as unknown as Record<string, unknown>)[key] === true

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
  const picked = leaving(record, viewer)
  // `personId` is `replaced`, so `pick` leaves it behind and it is written here.
  return picked === null ? null : { ...picked, personId: viewer.shareId }
}

/**
 * Whether `record` may leave at all: the one question `toShared` and the share
 * set both ask, so `shareSetStart` cannot date a record `shareSet` would not
 * send (second review of #180). The same answer for every viewer.
 */
function mayLeave(record: SessionRecord): boolean {
  return leaving(record, null) !== null
}

/**
 * `record` as its tables let it leave, or null: a `never` field set, a shape
 * that is not what its table expects, or a field a viewer cannot use it
 * without missing.
 */
function leaving(
  record: SessionRecord,
  viewer: Viewer | null,
): Omit<SharedRecord, 'personId'> | null {
  // Every field, its format first (KV-181): a record that is not what its type
  // says stays home rather than leaving for a viewer to puzzle over. A format
  // that is not one, or is newer than this build reads, is the first thing this
  // refuses — the field a viewer checks before anything else is the last one to
  // guess at (review of #182) — and a missing `id` the next, since a record
  // without one could never be updated or removed on a viewer's device (#45).
  if (checkRecord(record) !== null) return null
  const picked = pick(record, RECORD_POLICY, viewer)
  if (picked === REFUSED) return null
  // Written even where the record leaves it unsaid, as 1, so every record that
  // leaves says its format — and so the type below is true, not just asserted.
  return { ...(picked as Omit<SharedRecord, 'personId' | 'format'>), format: formatOf(record) }
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
    // The same plain order as the comparisons below, not `localeCompare`'s
    // collation, so the sort and the selection cannot disagree.
    .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0))
  // A real one: a seeded day standing in for "the latest" would let demo data
  // decide whether a person's real check-ins are sent (second review of #180).
  const latest = theirs.filter((r) => unusableReason(r.vitals) === null && mayLeave(r)).at(-1)
  if (latest === undefined) return []
  // Where the latest card's usual began, as it stored it (KV-154): the window
  // it was compared with, which a later change to the window's length must not
  // move (second review of #180). Recomputed only for a verdict stored before
  // the span was, or one that leaned on nothing.
  const stored: unknown = latest.assessment?.baselineSpan?.from
  const behind = baselineWindow(theirs.filter((r) => r.capturedAt < latest.capturedAt))
  const reach = typeof stored === 'string' ? stored : (behind[0] ?? latest).capturedAt
  return theirs.filter((r) => r.capturedAt >= reach && mayLeave(r))
}

/**
 * When a new viewer's history begins: the first check-in they will actually be
 * sent. Shown to the person when they approve, as the actual date (KV-32): the
 * usual counts 14 usable check-ins, not 14 days, so it can reach back weeks.
 *
 * **Its instant and its zone, not a date** (second review of #180). A UTC
 * instant cannot name a day without the zone it was taken in (KV-28): 23:40 on
 * 1 September in London is the 2nd in UTC. So the consent screen gets what
 * `localDateOf` takes, and dates it the way every other screen does.
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
export function shareSetStart(
  records: readonly SessionRecord[],
  personId: string,
): Pick<SessionRecord, 'capturedAt' | 'timeZone'> | null {
  const first = toBeSent(records, personId)[0]
  if (first === undefined) return null
  const { capturedAt, timeZone } = first
  return timeZone === undefined ? { capturedAt } : { capturedAt, timeZone }
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
  // Never empty: `toBeSent` kept only records that may leave, and whether one
  // may is the same for every viewer.
  return toBeSent(records, personId).flatMap((r) => toShared(r, viewer) ?? [])
}

/**
 * Why `value` is not a record as `toShared` sends one, or null when it is: what
 * a viewer asks of every record it receives, before reading it (KV-181).
 *
 * The same checks as `checkRecord`, steered by the share tables, so the two
 * cannot drift: a field the tables do not send is not looked for, a
 * `per-viewer` one may be missing, and `format` must be there, since
 * `toShared` always writes it. Fields it does not know are left alone, as a
 * newer sender may add one without changing the format (KV-30).
 *
 * A viewer holds a record this refuses aside and shows the rest (ARCHITECTURE.md,
 * KV-181): it knows whose the record is from the share it came in, and it never
 * rescores, so one bad record need not cost the caregiver the others.
 */
export function checkShared(value: unknown): string | null {
  if (!isShape(value)) return NOT_A_RECORD
  if (!holds(value as Record<string, unknown>, 'format')) return 'format is missing'
  if (checkFormat(value) === 'newer') {
    const said = String((value as { format: unknown }).format)
    return `it is in a newer format (${said}) than this app reads (${String(RECORD_FORMAT)})`
  }
  return checkSharedShape(RECORD_SPEC, RECORD_POLICY, value, '')
}

/** `checkShape` for a shape as it leaves: the entries `policy` sends, and no others. */
function checkSharedShape(
  spec: AnySpec,
  policy: AnyPolicy,
  value: unknown,
  at: string,
  also?: Nested['also'],
): string | null {
  if (!isShape(value)) return `${at === '' ? 'it' : at} is not a group of fields`
  const fields = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(spec)) {
    const sharing = policy[key]
    // Not sent, so not looked for.
    if (sharing === undefined || sharing === 'withheld' || sharing === 'never') continue
    const here = at === '' ? key : `${at}.${key}`
    const field = isOptional(entry) ? entry.optional : entry
    if (!holds(fields, key)) {
      // A `per-viewer` field is always optional in its type (`Leaf`), so this
      // covers a viewer who was not given it too.
      if (isOptional(entry)) continue
      return `${here} is missing`
    }
    const why =
      typeof sharing === 'object'
        ? checkSharedField(field, sharing, fields[key], here)
        : checkField(field, fields[key], here)
    if (why !== null) return why
  }
  return also === undefined ? null : also(fields, at === '' ? 'it' : at)
}

/** A field with a table of its own, checked as that table sends it. */
function checkSharedField(
  field: Field,
  sharing: AnyPolicy | ListPolicy<AnyPolicy>,
  value: unknown,
  at: string,
): string | null {
  if (LIST in sharing && typeof field === 'object' && 'listOf' in field) {
    if (!Array.isArray(value)) return `${at} is not a list`
    for (const [i, item] of value.entries()) {
      const why = checkSharedShape(field.listOf, sharing[LIST], item, `${at}[${String(i)}]`)
      if (why !== null) return why
    }
    return null
  }
  if (!(LIST in sharing) && typeof field === 'object' && 'shape' in field) {
    return checkSharedShape(field.shape, sharing, value, at, field.also)
  }
  // A table and a spec that disagree on what the field holds: checked as the
  // spec says, which is never looser than the type.
  return checkField(field, value, at)
}
