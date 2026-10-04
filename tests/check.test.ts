import { describe, expect, it } from 'vitest'
import {
  ANSWERS_SPEC,
  checkRecord,
  RECORD_SPEC,
  VITALS_SPEC,
  type Spec,
} from '@core/session/check'
import { createCheckIn } from '@core/session/checkin'
import { scoreSession } from '@core/scoring'
import { seedDemoHistory, withSeededVerdicts } from '@core/seed/persona'
import type { CheckInAnswers, SessionRecord, Vitals } from '@core/session/types'
import { history, session, sessionBeforeKV16 } from './helpers'

/**
 * Every field of a record read, checked against its type (KV-181).
 *
 * The first half is every shape the store has ever written, each of which must
 * pass: a check that refused one would lock a person out of their own history.
 * The second is every way a field can be wrong, each of which must be refused
 * with a reason naming the field.
 */

/** A record as the first builds wrote it: no zone, no format, the old meal question. */
function asFirstWritten(): Record<string, unknown> {
  return {
    id: 'scaffold-1',
    personId: 'demo-margaret',
    capturedAt: '2026-09-01T09:00:00.000Z',
    vitals: {
      pulseRateBpm: 72,
      breathingRateBrpm: 15,
      hrvRmssdMs: null,
      hrvSdnnMs: null,
      confidence: 0.9,
      stable: true,
      durationSec: 30,
    },
    answers: { mood: 'good', sleep: 'well', eatenToday: true, painReported: false },
    assessment: {
      flag: 'insufficient-signal',
      firedRules: [],
      summary: 'Not enough check-ins yet to compare.',
      baselineSessions: 0,
    },
  }
}

/** Sets `path` (`vitals.durationSec`) on a record, or deletes it for `undefined`. */
const set =
  (path: string, value: unknown) =>
  (record: Record<string, unknown>): void => {
    const keys = path.split('.')
    const last = keys.pop()!
    const parent = keys.reduce((o, k) => o[k] as Record<string, unknown>, record)
    if (value === undefined) delete parent[last]
    else parent[last] = value
  }

const RULE = { id: 'low-mood', title: 'Low mood', explanation: 'They said low.', severity: 0.1 }

describe('checkRecord passes every shape the store has ever written (KV-181)', () => {
  it('passes a record as the first builds wrote it', () => {
    expect(checkRecord(asFirstWritten())).toBeNull()
  })

  it('passes each field as it was added, absent before and present after', () => {
    const shapes: [string, (r: Record<string, unknown>) => void][] = [
      ['KV-12: a confidence nothing reported', set('vitals.confidence', null)],
      [
        'KV-16: the meal question asked now',
        set('answers', { mood: 'ok', sleep: 'ok', skippedMeal: true, painReported: true }),
      ],
      ['a pain note', set('answers.painNote', 'left hip')],
      ['KV-28: a zone', set('timeZone', 'Europe/London')],
      ['KV-30: a format', set('format', 1)],
      ['KV-53: seeded days behind it', set('assessment.baselineSeededSessions', 3)],
      [
        'KV-87: metrics not compared',
        set('assessment.uncomparedMetrics', [
          { metric: 'hrv', readings: 1, needed: 3 },
          { metric: 'pulse', readings: 2, needed: 3, mean: 80 },
        ]),
      ],
      ['KV-100: refused days behind it', set('assessment.baselineRefusedSessions', 2)],
      ['KV-138: why it was withheld', set('assessment.withheld', 'still-learning')],
      [
        'KV-154: the span of its usual',
        set('assessment.baselineSpan', {
          from: '2026-08-01T09:00:00.000Z',
          to: '2026-08-31T09:00:00.000Z',
        }),
      ],
      ['KV-30: the rules that scored it', set('assessment.rulesVersion', 1)],
      [
        'a rule the engine no longer has',
        set('assessment.firedRules', [{ ...RULE, id: 'not-eaten', title: 'Not eaten yet' }]),
      ],
      ['KV-8: a seeded day, with no verdict', (r) => {
        r.seeded = true
        delete r.assessment
      }],
    ]
    for (const [name, add] of shapes) {
      const record = asFirstWritten()
      add(record)
      expect(checkRecord(record), name).toBeNull()
    }
  })

  it('passes what a check-in writes today, and the demo history as it is shown', async () => {
    const stored: SessionRecord[] = []
    const checkIn = createCheckIn({
      store: { list: async () => history(5), append: async (r) => void stored.push(r) },
      score: scoreSession,
      now: () => new Date('2026-09-15T09:00:00.000Z'),
      newId: () => 'today',
      timeZone: () => 'Europe/London',
    })
    const { captureId } = await checkIn.capture('test-person', async () => session().vitals)
    await checkIn.submit('test-person', captureId, session().answers)
    expect(checkRecord(stored[0])).toBeNull()

    for (const day of withSeededVerdicts(seedDemoHistory(12, new Date('2026-09-20T09:00:00Z')))) {
      expect(checkRecord(day), day.id).toBeNull()
    }
    expect(checkRecord(sessionBeforeKV16(false))).toBeNull()
  })

  it('leaves alone a field it does not know, at any depth: a newer sender may add one', () => {
    const record = asFirstWritten()
    record.deviceNote = 'kitchen'
    ;(record.vitals as Record<string, unknown>).spo2Percent = 97
    ;(record.answers as Record<string, unknown>).energy = 'high'
    ;(record.assessment as Record<string, unknown>).trace = { why: 'x' }
    expect(checkRecord(record)).toBeNull()
  })
})

describe('checkRecord refuses a field that is not what its type says, and names it', () => {
  const WITHHELD =
    'nothing-measured, too-short, unrated, low-confidence, still-learning, uncompared'
  const cases: [string, (r: Record<string, unknown>) => unknown, string][] = [
    ['not a record', () => 'a check-in', 'it is not a check-in at all'],
    ['an empty id', set('id', ''), 'id is not an id'],
    ['no id', set('id', undefined), 'id is missing'],
    ['no person', set('personId', undefined), 'personId is missing'],
    ['a time that is not one', set('capturedAt', 'yesterday'), 'capturedAt is not a time'],
    ['null where a zone may only be absent', set('timeZone', null), 'timeZone is not text'],
    ['a format that is not one', set('format', '1'), 'format is not a record format'],
    [
      'a newer format',
      set('format', 2),
      'it is in a newer format (2) than this app reads (1)',
    ],
    ['vitals that are a list', set('vitals', []), 'vitals is not a group of fields'],
    [
      'a reading as text',
      set('vitals.durationSec', '30'),
      'vitals.durationSec is not a number',
    ],
    [
      'a reading not a number at all',
      set('vitals.pulseRateBpm', Number.NaN),
      'vitals.pulseRateBpm is not a number',
    ],
    [
      'a reading missing',
      set('vitals.breathingRateBrpm', undefined),
      'vitals.breathingRateBrpm is missing',
    ],
    ['stable as null', set('vitals.stable', null), 'vitals.stable is not true or false'],
    [
      'a mood no screen offers',
      set('answers.mood', 'great'),
      'answers.mood is not one of good, ok, low',
    ],
    [
      'both meal questions',
      set('answers.skippedMeal', false),
      'the meal question is answered both ways in answers',
    ],
    [
      'no meal question',
      set('answers.eatenToday', undefined),
      'the meal question has no answer in answers',
    ],
    ['a pain note that is not text', set('answers.painNote', 5), 'answers.painNote is not text'],
    [
      'a verdict that is not one',
      set('assessment.flag', 'red'),
      'assessment.flag is not one of normal, elevated, insufficient-signal',
    ],
    ['an assessment of null', set('assessment', null), 'assessment is not a group of fields'],
    [
      'fired rules that are not a list',
      set('assessment.firedRules', {}),
      'assessment.firedRules is not a list',
    ],
    [
      'one bad rule among good ones',
      set('assessment.firedRules', [RULE, { ...RULE, severity: 'high' }, RULE]),
      'assessment.firedRules[1].severity is not a number',
    ],
    [
      'a span that is not a time',
      set('assessment.baselineSpan', { from: 'x', to: 'y' }),
      'assessment.baselineSpan.from is not a time',
    ],
    [
      'a metric that is not compared',
      set('assessment.uncomparedMetrics', [{ metric: 'spo2', readings: 1, needed: 3 }]),
      'assessment.uncomparedMetrics[0].metric is not one of pulse, breathing, hrv',
    ],
    [
      'a reason never given',
      set('assessment.withheld', 'tired'),
      `assessment.withheld is not one of ${WITHHELD}`,
    ],
    ['seeded as text', set('seeded', 'yes'), 'seeded is not true or false'],
  ]

  for (const [name, spoil, why] of cases) {
    it(`refuses ${name}`, () => {
      // Each case spoils one field in place; only the first replaces the record.
      const record = asFirstWritten()
      const replaced = spoil(record)
      expect(checkRecord(name === 'not a record' ? replaced : record)).toBe(why)
    })
  }
})

describe('a spec cannot be left incomplete, or call a field optional that is not', () => {
  // Checked by the compiler: each `@ts-expect-error` fails the typecheck if the
  // line below it stops being an error.
  const any = (): null => null

  it('needs a check for every field of the shape', () => {
    const { durationSec: _seconds, ...rest } = VITALS_SPEC
    // @ts-expect-error `durationSec` has no check
    const missing: Spec<Vitals> = rest
    expect(missing).not.toHaveProperty('durationSec')
  })

  it('takes a field as optional exactly when its type lets it be missing', () => {
    // @ts-expect-error `stable` is required, so it cannot be checked as optional
    const looser: Spec<Vitals> = { ...VITALS_SPEC, stable: { optional: any } }
    // @ts-expect-error `timeZone` may be missing, so it cannot be required
    const stricter: Spec<SessionRecord> = { ...RECORD_SPEC, timeZone: any }
    // @ts-expect-error each meal answer is missing on one branch of the union
    const meal: Spec<CheckInAnswers> = { ...ANSWERS_SPEC, skippedMeal: any }
    expect([looser.stable, stricter.timeZone, meal.skippedMeal]).toHaveLength(3)
  })
})
