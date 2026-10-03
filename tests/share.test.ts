import { describe, expect, it } from 'vitest'
import {
  ANSWERS_POLICY,
  ASSESSMENT_POLICY,
  BASELINE_SPAN_POLICY,
  FIRED_RULE_POLICY,
  RECORD_POLICY,
  UNCOMPARED_POLICY,
  VITALS_POLICY,
  shareSet,
  shareSetStart,
  toShared,
  type Policy,
  type Viewer,
} from '@core/share'
import type { Assessment, SessionRecord, Vitals } from '@core/session/types'
import { scoreSession } from '@core/scoring'
import { localDateOf } from '@core/session/time'
import { history, session, sessionBeforeKV16 } from './helpers'

/**
 * What may leave the device (KV-37), held to KV-32's policy in ARCHITECTURE.md.
 *
 * The record below sets every field the types allow, optional ones included,
 * so a table entry that stopped being honoured — or a field copied that no
 * table names — shows here rather than on a viewer's phone.
 */

const VIEWER: Viewer = { shareId: 'share-7f3a', painNote: false }
const WITH_NOTE: Viewer = { ...VIEWER, painNote: true }

const ASSESSMENT: Required<Assessment> = {
  flag: 'elevated',
  summary: 'Different from their usual — pulse above usual.',
  firedRules: [
    {
      id: 'pulse-elevated',
      title: 'Pulse above usual',
      explanation: 'Pulse was 95 bpm.',
      severity: 0.4,
    },
  ],
  baselineSessions: 9,
  baselineSeededSessions: 3,
  baselineRefusedSessions: 2,
  baselineSpan: { from: '2026-08-01T09:00:00.000Z', to: '2026-09-10T09:00:00.000Z' },
  uncomparedMetrics: [{ metric: 'hrv', readings: 1, needed: 3, mean: 31 }],
  withheld: 'uncompared',
  rulesVersion: 1,
}

/** A real check-in with every field set. */
function everything(): SessionRecord {
  const record = session({
    id: 'r-1',
    capturedAt: '2026-09-15T09:00:00.000Z',
    timeZone: 'Europe/London',
    format: 1,
    vitals: { hrvSdnnMs: 41 },
    answers: { painReported: true, painNote: 'left hip, since yesterday' },
  })
  record.assessment = structuredClone(ASSESSMENT)
  // Set, and false, so even the field that never leaves is present to be left behind.
  record.seeded = false
  return record
}

describe('toShared: one check-in as a viewer receives it (KV-37)', () => {
  it('sends every field its table sends, and nothing else, in both directions', () => {
    // Both ways round (review of #180): nothing leaves that its table does not
    // send, and nothing its table sends is missing. Only the first was checked,
    // so a table entry flipped to `withheld` passed while a viewer's cards lost
    // the field.
    const record = everything()
    const before = sessionBeforeKV16(true, { answers: { painReported: true, painNote: 'knee' } })
    const shared = toShared(record, WITH_NOTE)!
    const old = toShared(before, WITH_NOTE)!
    const tables: [string, object, object, Record<string, unknown>][] = [
      ['record', record, shared, RECORD_POLICY],
      ['vitals', record.vitals, shared.vitals, VITALS_POLICY],
      ['answers', record.answers, shared.answers, ANSWERS_POLICY],
      ['answers before KV-16', before.answers, old.answers, ANSWERS_POLICY],
      ['assessment', record.assessment!, shared.assessment!, ASSESSMENT_POLICY],
      [
        'firedRules[0]',
        record.assessment!.firedRules[0]!,
        shared.assessment!.firedRules[0]!,
        FIRED_RULE_POLICY,
      ],
      [
        'uncomparedMetrics[0]',
        record.assessment!.uncomparedMetrics![0]!,
        shared.assessment!.uncomparedMetrics![0]!,
        UNCOMPARED_POLICY,
      ],
      [
        'baselineSpan',
        record.assessment!.baselineSpan!,
        shared.assessment!.baselineSpan!,
        BASELINE_SPAN_POLICY,
      ],
    ]
    // Leaves as itself or rebuilt by its own table; `personId` as the share's
    // id; the pain note because this viewer has it turned on.
    const leaves = (entry: unknown): boolean => entry !== 'withheld' && entry !== 'never'
    for (const [where, source, out, policy] of tables) {
      for (const key of Object.keys(out)) {
        expect(leaves(policy[key]), `${where}.${key} left without a table saying so`).toBe(true)
      }
      for (const key of Object.keys(policy).filter((k) => leaves(policy[k]))) {
        if (!Object.hasOwn(source, key)) continue
        expect(out, `${where}.${key} did not arrive`).toHaveProperty(key)
      }
    }
    // The fixtures hold every field the tables name, so the second loop above
    // skips nothing but the other meal question on each side.
    for (const [where, source, , policy] of tables) {
      const unset = Object.keys(policy).filter((k) => !Object.hasOwn(source, k))
      const otherMealQuestion: Record<string, string[]> = {
        answers: ['eatenToday'],
        'answers before KV-16': ['skippedMeal'],
      }
      expect(unset, where).toEqual(otherMealQuestion[where] ?? [])
    }
    // And what is shared is the value the record holds.
    expect(shared.vitals.pulseRateBpm).toBe(record.vitals.pulseRateBpm)
    expect(shared.assessment).toEqual(ASSESSMENT)
    expect(shared.capturedAt).toBe(record.capturedAt)
    expect(shared.timeZone).toBe('Europe/London')
  })

  it('keeps home a record whose format is not one it can read (review of #182)', () => {
    for (const format of ['2', 0, -1, 1.5, Number.NaN, null, 2]) {
      const record = { ...everything(), format } as unknown as SessionRecord
      expect(toShared(record, VIEWER), String(format)).toBeNull()
    }
    // And so the share set never sends one, nor dates the share by it.
    const days = [
      session({ id: 'odd', format: 0 }),
      session({ id: 'fine', capturedAt: '2026-09-16T09:00:00.000Z' }),
    ]
    expect(shareSet(days, 'test-person', VIEWER).map((r) => r.id)).toEqual(['fine'])
  })

  it('always says which format it is in, as 1 for a record from before it said so (KV-30)', () => {
    expect(RECORD_POLICY.format).toBe('shared')
    expect(toShared(everything(), VIEWER)!.format).toBe(1)
    const before = session()
    expect(before).not.toHaveProperty('format')
    expect(toShared(before, VIEWER)!.format).toBe(1)
  })

  it('withholds what the policy withholds', () => {
    const shared = toShared(everything(), VIEWER)!
    expect(VITALS_POLICY.hrvSdnnMs).toBe('withheld')
    expect(shared.vitals).not.toHaveProperty('hrvSdnnMs')
    expect(shared).not.toHaveProperty('seeded')
  })

  it("replaces the local person id with the share's own", () => {
    expect(RECORD_POLICY.personId).toBe('replaced')
    const shared = toShared(everything(), VIEWER)!
    expect(shared.personId).toBe('share-7f3a')
    expect(JSON.stringify(shared)).not.toContain('test-person')
  })

  it('sends the pain note only to a viewer the person turned it on for', () => {
    expect(ANSWERS_POLICY.painNote).toBe('per-viewer')
    expect(toShared(everything(), VIEWER)!.answers).not.toHaveProperty('painNote')
    expect(toShared(everything(), WITH_NOTE)!.answers.painNote).toBe('left hip, since yesterday')
    // On for the viewer, but no note written: nothing to send.
    expect(toShared(session(), WITH_NOTE)!.answers).not.toHaveProperty('painNote')
  })

  it('never sends a seeded record', () => {
    expect(RECORD_POLICY.seeded).toBe('never')
    expect(toShared(session({ seeded: true }), WITH_NOTE)).toBeNull()
    // `seeded: false` is a real check-in, and leaves like one.
    expect(toShared(everything(), WITH_NOTE)).not.toBeNull()
  })

  it('makes every viewer say whether it has each per-viewer field', () => {
    // @ts-expect-error the pain note is `per-viewer`, so a viewer must say
    const unsaid: Viewer = { shareId: 'share-1' }
    expect(unsaid).not.toHaveProperty('painNote')
  })

  it('allows `never` only on a true/false field, where "true" means something', () => {
    // The seeded test above is what shows the table, not a rule beside it,
    // keeps a record home (second review of #180).
    interface Inner {
      keepHome: boolean
      reading: number
    }
    const inner = { keepHome: 'never', reading: 'shared' } as const satisfies Policy<Inner>
    // @ts-expect-error `never` means something only for a true/false field
    const onANumber: Policy<Inner> = { keepHome: 'never', reading: 'never' }
    expect([inner.keepHome, onANumber.reading]).toEqual(['never', 'never'])
  })

  it('sends a record from before KV-16 with the question it was asked', () => {
    const shared = toShared(sessionBeforeKV16(false), VIEWER)!
    expect(shared.answers).toEqual({
      mood: 'good',
      sleep: 'well',
      eatenToday: false,
      painReported: false,
    })
    expect(shared.answers).not.toHaveProperty('skippedMeal')
  })

  it('leaves behind anything a stored record carries that no table names', () => {
    // The store reads JSON without checking every field: a hand-edited file, or
    // a field from a newer client, must not ride along because it was there.
    const record = everything() as SessionRecord & Record<string, unknown>
    record.homeAddress = '12 Elm Street'
    ;(record.vitals as unknown as Record<string, unknown>).spo2Percent = 97
    ;(record.answers as unknown as Record<string, unknown>).caregiverNote = 'private'
    ;(record.assessment as unknown as Record<string, unknown>).debugTrace = 'stack'
    ;(record.assessment!.firedRules[0] as unknown as Record<string, unknown>).internal = 1
    const text = JSON.stringify(toShared(record, WITH_NOTE))
    const leaks = ['homeAddress', 'spo2Percent', 'caregiverNote', 'debugTrace', 'internal']
    for (const leaked of leaks) {
      expect(text, leaked).not.toContain(leaked)
    }
  })

  it('writes nothing for a field the record does not have', () => {
    const shared = toShared(session(), VIEWER)!
    expect(shared).not.toHaveProperty('timeZone')
    expect(shared).not.toHaveProperty('assessment')
    expect(Object.values(shared.vitals)).not.toContain(undefined)
  })

  it('shares no object with the record it came from', () => {
    const record = everything()
    const shared = toShared(record, WITH_NOTE)!
    shared.vitals.pulseRateBpm = 1
    shared.answers.mood = 'low'
    shared.assessment!.firedRules[0]!.title = 'changed'
    shared.assessment!.baselineSpan!.from = 'changed'
    shared.assessment!.uncomparedMetrics![0]!.readings = 99
    expect(record.vitals.pulseRateBpm).toBe(72)
    expect(record.answers.mood).toBe('good')
    expect(record.assessment).toEqual(ASSESSMENT)
  })
})

describe('the tables cannot be left incomplete (review of #180)', () => {
  // Checked by the compiler, not at run time: each `@ts-expect-error` fails the
  // typecheck if the line below it stops being an error.
  it('need every field of every branch of a union, not only the ones they share', () => {
    // `MealAnswer` names both meal fields on both branches, so it cannot show
    // this; a union whose branches differ can, as a field added to one would.
    type OneSided = { both: boolean; onlyHere: string } | { both: boolean }
    // @ts-expect-error `onlyHere` is on one branch, and still needs deciding
    const missing: Policy<OneSided> = { both: 'shared' }
    expect(missing).not.toHaveProperty('onlyHere')
  })

  it('give the shared type exactly what the tables send', () => {
    const record = everything()
    const shared = toShared(record, WITH_NOTE)!
    // @ts-expect-error withheld, so not on the shared type either
    expect(shared.vitals.hrvSdnnMs).toBeUndefined()
    // @ts-expect-error never leaves, so not on the shared type either
    expect(shared.seeded).toBeUndefined()
    // A viewer that needs a `Vitals` supplies only the withheld field (KV-32):
    // this compiles only while the table sends every other one, `confidence`
    // included, which `unusableReason` reads.
    const forScoring: Vitals = { ...shared.vitals, hrvSdnnMs: null }
    expect(forScoring).toEqual({ ...record.vitals, hrvSdnnMs: null })
    // The meal question stays a union, and the pain note stays optional.
    const meal: boolean | undefined = shared.answers.skippedMeal ?? shared.answers.eatenToday
    const note: string | undefined = shared.answers.painNote
    expect([meal, note]).toEqual([false, 'left hip, since yesterday'])
  })

  it('cannot send a shape whole to one viewer either (second review of #180)', () => {
    interface Clip {
      url: string
      transcript: string
    }
    // @ts-expect-error `per-viewer` would copy the shape whole once granted
    const perViewer: Policy<{ note: string; clip: Clip }> = { note: 'shared', clip: 'per-viewer' }
    expect(perViewer.clip).toBe('per-viewer')
  })

  it('cannot share a field that is sometimes a shape, or a list that sometimes holds one', () => {
    interface Clip {
      url: string
      transcript: string
    }
    // @ts-expect-error `details` can hold a `Clip`, so `shared` is not an answer for it
    const mixed: Policy<{ details: string | Clip }> = { details: 'shared' }
    // @ts-expect-error nor for a list whose items can be one
    const mixedList: Policy<{ items: (string | Clip)[] }> = { items: 'shared' }
    // A list of plain values is a plain value.
    const plainList: Policy<{ tags: string[] }> = { tags: 'shared' }
    expect([mixed.details, mixedList.items, plainList.tags]).toEqual(['shared', 'shared', 'shared'])
  })

  it('refuses a record holding a list where one shape belongs, or the reverse', () => {
    const asList = everything()
    ;(asList as unknown as { vitals: unknown }).vitals = [asList.vitals, asList.vitals]
    expect(toShared(asList, VIEWER)).toBeNull()

    const asOne = everything()
    const rules = asOne.assessment!.firedRules
    ;(asOne.assessment as unknown as { firedRules: unknown }).firedRules = rules[0]
    expect(toShared(asOne, VIEWER)).toBeNull()

    const notAShape = everything()
    ;(notAShape as unknown as { answers: unknown }).answers = 'good'
    expect(toShared(notAShape, VIEWER)).toBeNull()
  })

  it('refuses a record missing a field a viewer cannot use it without', () => {
    // No `id` and it can never be updated or removed on the viewer's device (#45).
    for (const key of ['id', 'capturedAt', 'vitals', 'answers'] as const) {
      const record = everything()
      delete (record as Partial<SessionRecord>)[key]
      expect(toShared(record, VIEWER), key).toBeNull()
    }
    // Optional ones may be absent, as on any record from before them.
    expect(toShared(session(), VIEWER)).not.toBeNull()
  })

  it('refuses a record holding an object where its table expects a plain value', () => {
    const record = everything()
    ;(record as unknown as { timeZone: unknown }).timeZone = { region: 'Europe', history: [] }
    expect(toShared(record, VIEWER)).toBeNull()
  })

  it('refuses a record whose list holds anything but shapes, rather than shortening it', () => {
    // Three fired rules, the middle one corrupt: two arriving would leave the
    // verdict quoting a rule its evidence no longer shows.
    const record = everything()
    const [rule] = record.assessment!.firedRules
    ;(record.assessment as unknown as { firedRules: unknown[] }).firedRules = [rule, 'trunc', rule]
    expect(toShared(record, VIEWER)).toBeNull()
  })

  it('cannot share a shape whole: it is decided field by field by its own table', () => {
    // @ts-expect-error `vitals` holds a shape, so `shared` is not an answer for it
    const whole: Policy<SessionRecord> = { ...RECORD_POLICY, vitals: 'shared' }
    expect(whole.vitals).toBe('shared')
  })
})

describe('shareSet: what a new viewer is sent (KV-32)', () => {
  /**
   * One of this person's check-ins, `day` days after 09:00 on 1 August. Added
   * in milliseconds, so half a day is twelve hours: `Date.UTC` truncates a
   * fractional day, which made `19.5` the same instant as `19` (review of #180).
   */
  const on = (day: number, over: Parameters<typeof session>[0] = {}): SessionRecord =>
    session({
      id: `d-${day}`,
      capturedAt: new Date(Date.UTC(2026, 7, 1, 9) + day * 86_400_000).toISOString(),
      ...over,
    })
  const refused = (day: number): SessionRecord =>
    on(day, { id: `refused-${day}`, vitals: { confidence: 0.2 } })

  it('reaches back to the earliest check-in behind the current usual', () => {
    // Twenty usable days; the latest was compared with the 14 before it.
    const days = Array.from({ length: 20 }, (_, i) => on(i))
    expect(shareSetStart(days, 'test-person')?.capturedAt).toBe(days[5]!.capturedAt)
    expect(shareSet(days, 'test-person', VIEWER).map((r) => r.id)).toEqual(
      days.slice(5).map((r) => r.id),
    )
  })

  it('counts usable check-ins, not days: twice a week reaches back about seven weeks', () => {
    const twiceAWeek = Array.from({ length: 20 }, (_, i) => on(Math.round(i * 3.5)))
    const start = Date.parse(shareSetStart(twiceAWeek, 'test-person')!.capturedAt)
    const latest = Date.parse(twiceAWeek.at(-1)!.capturedAt)
    expect((latest - start) / 86_400_000).toBeGreaterThanOrEqual(45)
  })

  it('sends each record as it leaves for this viewer, never the record itself', () => {
    const days = Array.from({ length: 4 }, (_, i) =>
      on(i, { vitals: { hrvSdnnMs: 41 }, answers: { painReported: true, painNote: 'knee' } }),
    )
    for (const [viewer, note] of [[VIEWER, undefined], [WITH_NOTE, 'knee']] as const) {
      for (const sent of shareSet(days, 'test-person', viewer)) {
        expect(sent).toEqual(toShared(days.find((d) => d.id === sent.id)!, viewer))
        expect(sent.personId).toBe('share-7f3a')
        expect(sent.vitals).not.toHaveProperty('hrvSdnnMs')
        expect(sent.answers.painNote).toBe(note)
      }
    }
  })

  it('includes refused captures within that span, and none before it', () => {
    const usable = Array.from({ length: 20 }, (_, i) => on(i))
    const days = [...usable, refused(2), refused(9), refused(19.5)]
    const sent = shareSet(days, 'test-person', VIEWER).map((r) => r.id)
    expect(sent).toContain('refused-9')
    // Twelve hours after the latest usable check-in, not alongside it.
    expect(on(19.5).capturedAt > days[19]!.capturedAt).toBe(true)
    expect(sent.at(-1)).toBe('refused-19.5')
    expect(sent).not.toContain('refused-2')
  })

  it('never includes seeded records, or anyone else', () => {
    const days = [
      ...Array.from({ length: 6 }, (_, i) => on(i, { seeded: true, id: `seed-${i}` })),
      ...Array.from({ length: 4 }, (_, i) => on(6 + i)),
      on(7.5, { id: 'someone-else' }),
    ]
    days.at(-1)!.personId = 'another-person'
    const sent = shareSet(days, 'test-person', VIEWER).map((r) => r.id)
    expect(sent.filter((id) => id.startsWith('seed-'))).toEqual([])
    expect(sent).not.toContain('someone-else')
  })

  it('starts where what is sent starts, not at a seeded day behind the usual', () => {
    // A demo install: twelve seeded days, then two real check-ins.
    const seeded = Array.from({ length: 12 }, (_, i) => on(i, { seeded: true, id: `seed-${i}` }))
    const real = [on(31, { id: 'real-1' }), on(32, { id: 'real-2' })]
    expect(shareSetStart([...seeded, ...real], 'test-person')?.capturedAt).toBe(real[0]!.capturedAt)
    expect(shareSet([...seeded, ...real], 'test-person', VIEWER).map((r) => r.id)).toEqual([
      'real-1',
      'real-2',
    ])
    // Seeded days only: nothing would be sent, so there is no date to show.
    expect(shareSetStart(seeded, 'test-person')).toBeNull()
    expect(shareSet(seeded, 'test-person', VIEWER)).toEqual([])
  })

  it('reaches back as far as the latest card says its usual began, and no further', () => {
    // Scored as `submit` scores them, so each stores the span it was compared with.
    const days: SessionRecord[] = []
    for (let i = 0; i < 20; i++) {
      const day = on(i)
      day.assessment = scoreSession(day, days)
      days.push(day)
    }
    const latest = days.at(-1)!
    const span = latest.assessment!.baselineSpan!
    expect(shareSetStart(days, 'test-person')?.capturedAt).toBe(span.from)

    // A window since shortened would recompute a later start; the stored span,
    // which the card quotes, still decides.
    latest.assessment = {
      ...latest.assessment!,
      baselineSpan: { ...span, from: days[2]!.capturedAt },
    }
    expect(shareSetStart(days, 'test-person')?.capturedAt).toBe(days[2]!.capturedAt)
  })

  it('gives the start with its zone, so the consent screen names the day it was there', () => {
    // 23:40 on 1 September in London is 22:40 UTC; elsewhere it could be the 2nd.
    const late = on(0, { capturedAt: '2026-09-01T22:40:00.000Z', timeZone: 'Europe/London' })
    const start = shareSetStart([late], 'test-person')!
    expect(start).toEqual({ capturedAt: '2026-09-01T22:40:00.000Z', timeZone: 'Europe/London' })
    expect(localDateOf(start)).toBe('2026-09-01')
    // Nothing else of the record comes with it.
    expect(Object.keys(start)).toEqual(['capturedAt', 'timeZone'])
    expect(shareSetStart([on(0)], 'test-person')).toEqual({ capturedAt: on(0).capturedAt })
  })

  it('lets no seeded day stand in for the latest usable check-in', () => {
    // The same real data — two refused captures — with and without a demo
    // fortnight behind it, gets the same answer: nothing usable, nothing sent.
    const real = [refused(60), refused(61)]
    const seeded = Array.from({ length: 20 }, (_, i) => on(i, { seeded: true, id: `seed-${i}` }))
    expect(shareSetStart(real, 'test-person')).toBeNull()
    expect(shareSetStart([...seeded, ...real], 'test-person')).toBeNull()
    expect(shareSet([...seeded, ...real], 'test-person', VIEWER)).toEqual([])
  })

  it('dates the share by the first record actually sent, whatever else refuses one', () => {
    // A record that cannot leave, at the start of the window, must not set the date.
    const days = Array.from({ length: 20 }, (_, i) => on(i))
    ;(days[5] as unknown as { answers: unknown }).answers = 'corrupt'
    const sent = shareSet(days, 'test-person', VIEWER)
    expect(sent.map((r) => r.id)).not.toContain(days[5]!.id)
    expect(shareSetStart(days, 'test-person')?.capturedAt).toBe(sent[0]!.capturedAt)
  })

  it('reaches back to the check-ins a card still learning was counted against', () => {
    // Two usable days before the latest: no usual yet, but the latest card says
    // "2 of 3", so the two it counted are sent with it.
    const days = [on(0), on(1), on(2)]
    expect(shareSetStart(days, 'test-person')?.capturedAt).toBe(days[0]!.capturedAt)
  })

  it('starts at the latest when nothing came before it, and is empty with none usable', () => {
    expect(shareSetStart([on(3)], 'test-person')?.capturedAt).toBe(on(3).capturedAt)
    expect(shareSetStart([refused(1)], 'test-person')).toBeNull()
    expect(shareSet([refused(1)], 'test-person', VIEWER)).toEqual([])
    expect(shareSet(history(0), 'test-person', VIEWER)).toEqual([])
  })
})
