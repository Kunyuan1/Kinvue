import type { CheckInAnswers, SessionRecord, Vitals } from '@core/session/types'

/** The answers a check-in written today carries: the meal question as asked now (KV-16). */
type NewAnswers = Extract<CheckInAnswers, { skippedMeal: boolean }>

const GOOD_ANSWERS: NewAnswers = {
  mood: 'good',
  sleep: 'well',
  skippedMeal: false,
  painReported: false,
}

const GOOD_VITALS: Vitals = {
  pulseRateBpm: 72,
  breathingRateBrpm: 15,
  hrvRmssdMs: 34,
  hrvSdnnMs: 42,
  confidence: 0.9,
  stable: true,
  durationSec: 30,
}

/** A session that fires no rules, so a test only has to state its deviation. */
export function session(
  overrides: {
    vitals?: Partial<Vitals>
    answers?: Partial<Omit<NewAnswers, 'eatenToday'>>
    capturedAt?: string
    id?: string
    seeded?: true
    timeZone?: string
    format?: number
  } = {},
): SessionRecord {
  const record: SessionRecord = {
    id: overrides.id ?? 'test-session',
    personId: 'test-person',
    capturedAt: overrides.capturedAt ?? '2026-09-15T09:00:00.000Z',
    vitals: { ...GOOD_VITALS, ...overrides.vitals },
    answers: { ...GOOD_ANSWERS, ...overrides.answers },
  }
  // Set only when true, as core/seed does: absent means measured.
  if (overrides.seeded === true) record.seeded = true
  // Likewise absent unless asked for: a record with no zone is a real case
  // (anything written before KV-28, or a device that could not say).
  if (overrides.timeZone !== undefined) record.timeZone = overrides.timeZone
  // Absent unless asked for too, as on every record from before KV-30.
  if (overrides.format !== undefined) record.format = overrides.format
  return record
}

/**
 * A check-in written before KV-16: asked "have you eaten today?", so it has
 * `eatenToday` and no `skippedMeal` at all — the field absent, as on disk, not
 * set to `undefined`. Stated once here, because `session()` spreads today's
 * answers first, and forgetting to take `skippedMeal` out made a record with
 * both answers instead of an old one (review of #167).
 */
export function sessionBeforeKV16(
  eatenToday: boolean,
  overrides: Parameters<typeof session>[0] = {},
): SessionRecord {
  const record = session(overrides)
  const { skippedMeal: _asked, ...rest } = record.answers
  record.answers = { ...rest, eatenToday }
  return record
}

/** `count` unremarkable prior sessions, one per day, ending before the scored one. */
export function history(count: number, overrides: Partial<Vitals> = {}): SessionRecord[] {
  return Array.from({ length: count }, (_, i) =>
    session({
      id: `h-${i}`,
      capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
      vitals: overrides,
    }),
  )
}

/**
 * The same, but invented — the shape `core/seed` writes for the demo persona,
 * including the zone it stamps on every record. Dated before `history()`'s days
 * so a mixed history has one check-in per day, as a real store does, rather
 * than pairs sharing an instant.
 */
export function seededHistory(count: number, overrides: Partial<Vitals> = {}): SessionRecord[] {
  return Array.from({ length: count }, (_, i) =>
    session({
      id: `seed-${i}`,
      capturedAt: new Date(Date.UTC(2026, 7, i + 1, 9)).toISOString(),
      seeded: true,
      timeZone: 'Europe/London',
      vitals: overrides,
    }),
  )
}
