import type { CheckInAnswers, SessionRecord, Vitals } from '@core/session/types'

const GOOD_ANSWERS: CheckInAnswers = {
  mood: 'good',
  sleep: 'well',
  eatenToday: true,
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
    answers?: Partial<CheckInAnswers>
    capturedAt?: string
    id?: string
  } = {},
): SessionRecord {
  return {
    id: overrides.id ?? 'test-session',
    personId: 'test-person',
    capturedAt: overrides.capturedAt ?? '2026-09-15T09:00:00.000Z',
    vitals: { ...GOOD_VITALS, ...overrides.vitals },
    answers: { ...GOOD_ANSWERS, ...overrides.answers },
  }
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
