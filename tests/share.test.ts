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
  type Viewer,
} from '@core/share'
import type { Assessment, SessionRecord } from '@core/session/types'
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
  firedRules: [{ id: 'pulse-elevated', title: 'Pulse above usual', explanation: 'Pulse was 95 bpm.', severity: 0.4 }],
  baselineSessions: 9,
  baselineSeededSessions: 3,
  baselineRefusedSessions: 2,
  baselineSpan: { from: '2026-08-01T09:00:00.000Z', to: '2026-09-10T09:00:00.000Z' },
  uncomparedMetrics: [{ metric: 'hrv', readings: 1, needed: 3, mean: 31 }],
  withheld: 'uncompared',
}

/** A real check-in with every field set. */
function everything(): SessionRecord {
  const record = session({
    id: 'r-1',
    capturedAt: '2026-09-15T09:00:00.000Z',
    timeZone: 'Europe/London',
    vitals: { hrvSdnnMs: 41 },
    answers: { painReported: true, painNote: 'left hip, since yesterday' },
  })
  record.assessment = structuredClone(ASSESSMENT)
  return record
}

describe('toShared: one check-in as a viewer receives it (KV-37)', () => {
  it('sends every field its table calls shared, and nothing else', () => {
    const record = everything()
    const shared = toShared(record, VIEWER)!
    const tables: [string, object, Record<string, string>][] = [
      ['vitals', shared.vitals, VITALS_POLICY],
      ['answers', shared.answers, ANSWERS_POLICY],
      ['assessment', shared.assessment!, ASSESSMENT_POLICY],
      ['firedRules[0]', shared.assessment!.firedRules[0]!, FIRED_RULE_POLICY],
      ['uncomparedMetrics[0]', shared.assessment!.uncomparedMetrics![0]!, UNCOMPARED_POLICY],
      ['baselineSpan', shared.assessment!.baselineSpan!, BASELINE_SPAN_POLICY],
    ]
    for (const [where, out, policy] of tables) {
      const sharedKeys = Object.keys(policy).filter((k) => policy[k] === 'shared')
      for (const key of Object.keys(out)) {
        expect(sharedKeys, `${where}.${key} left without a table saying so`).toContain(key)
      }
    }
    // And what is shared is the value the record holds.
    expect(shared.vitals.pulseRateBpm).toBe(record.vitals.pulseRateBpm)
    expect(shared.assessment).toEqual(ASSESSMENT)
    expect(shared.capturedAt).toBe(record.capturedAt)
    expect(shared.timeZone).toBe('Europe/London')
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
  })

  it('sends a record from before KV-16 with the question it was asked', () => {
    const shared = toShared(sessionBeforeKV16(false), VIEWER)!
    expect(shared.answers).toEqual({ mood: 'good', sleep: 'well', eatenToday: false, painReported: false })
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
    for (const leaked of ['homeAddress', 'spo2Percent', 'caregiverNote', 'debugTrace', 'internal']) {
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

describe('shareSet: what a new viewer is sent (KV-32)', () => {
  /** One of this person's check-ins, `day` days after 1 August. */
  const on = (day: number, over: Parameters<typeof session>[0] = {}): SessionRecord =>
    session({ id: `d-${day}`, capturedAt: new Date(Date.UTC(2026, 7, 1 + day, 9)).toISOString(), ...over })
  const refused = (day: number): SessionRecord => on(day, { id: `refused-${day}`, vitals: { confidence: 0.2 } })

  it('reaches back to the earliest check-in behind the current usual', () => {
    // Twenty usable days; the latest was compared with the 14 before it.
    const days = Array.from({ length: 20 }, (_, i) => on(i))
    expect(shareSetStart(days, 'test-person')).toBe(days[5]!.capturedAt)
    expect(shareSet(days, 'test-person').map((r) => r.id)).toEqual(days.slice(5).map((r) => r.id))
  })

  it('counts usable check-ins, not days: twice a week reaches back about seven weeks', () => {
    const twiceAWeek = Array.from({ length: 20 }, (_, i) => on(Math.round(i * 3.5)))
    const start = Date.parse(shareSetStart(twiceAWeek, 'test-person')!)
    const latest = Date.parse(twiceAWeek.at(-1)!.capturedAt)
    expect((latest - start) / 86_400_000).toBeGreaterThanOrEqual(45)
  })

  it('includes refused captures within that span, and none before it', () => {
    const days = [...Array.from({ length: 20 }, (_, i) => on(i)), refused(2), refused(9), refused(19.5)]
    const sent = shareSet(days, 'test-person').map((r) => r.id)
    expect(sent).toContain('refused-9')
    expect(sent).toContain('refused-19.5')
    expect(sent).not.toContain('refused-2')
  })

  it('never includes seeded records, or anyone else', () => {
    const days = [
      ...Array.from({ length: 6 }, (_, i) => on(i, { seeded: true, id: `seed-${i}` })),
      ...Array.from({ length: 4 }, (_, i) => on(6 + i)),
      on(7.5, { id: 'someone-else' }),
    ]
    days.at(-1)!.personId = 'another-person'
    const sent = shareSet(days, 'test-person')
    expect(sent.some((r) => r.seeded === true)).toBe(false)
    expect(sent.map((r) => r.id)).not.toContain('someone-else')
  })

  it('starts at the latest check-in while there is no usual yet, and sends nothing with none usable', () => {
    expect(shareSetStart([on(3)], 'test-person')).toBe(on(3).capturedAt)
    expect(shareSetStart([refused(1)], 'test-person')).toBeNull()
    expect(shareSet([refused(1)], 'test-person')).toEqual([])
    expect(shareSet(history(0), 'test-person')).toEqual([])
  })
})
