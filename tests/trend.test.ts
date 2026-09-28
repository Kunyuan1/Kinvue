import { describe, expect, it } from 'vitest'
import { BASELINE_WINDOW_SESSIONS, computeBaseline } from '@core/baseline'
import { scoreSession } from '@core/scoring'
import { trendNotes, trendOf, trendTitle, usualLabel } from '@core/trend'
import type { SessionRecord } from '@core/session/types'
import { history, seededHistory, session } from './helpers'

/** Words that say when relative to now (KV-93); the chart is drawn for "the latest". */
const RELATIVE_TIME =
  /\b(today|tonight|tomorrow|yesterday|last night|this (morning|afternoon|evening|week)|right now|currently|earlier)\b/i

const P = 'test-person'
const latest = (over: Parameters<typeof session>[0] = {}): SessionRecord =>
  session({ id: 'latest', capturedAt: '2026-10-01T09:00:00.000Z', ...over })
const refused = (id: string, capturedAt: string): SessionRecord =>
  session({ id, capturedAt, vitals: { confidence: 0.2 } })

describe('trendOf: one metric over the baseline window (KV-4)', () => {
  it('draws the window the latest check-in was scored against, and marks it', () => {
    const prior = history(5, { pulseRateBpm: 70 })
    const trend = trendOf([...prior, latest({ vitals: { pulseRateBpm: 90 } })], P, 'pulse')
    expect(trend?.points.map((p) => p.id)).toEqual([...prior.map((p) => p.id), 'latest'])
    expect(trend?.points.filter((p) => p.latest).map((p) => p.id)).toEqual(['latest'])
    expect(trend?.points.at(-1)?.value).toBe(90)
  })

  it('draws the usual the scorer compared with, not a second opinion', () => {
    const prior = [72, 78, 69, 81, 75].map((pulse, i) =>
      session({ id: `p-${i}`, capturedAt: `2026-09-0${i + 1}T09:00:00.000Z`, vitals: { pulseRateBpm: pulse } }),
    )
    const now = latest({ vitals: { pulseRateBpm: 110 } })
    const trend = trendOf([...prior, now], P, 'pulse')
    expect(trend?.usual).toBe(computeBaseline(prior).pulseRateBpm?.mean)
    // The card's own rule quotes the same number the line is labelled with.
    const fired = scoreSession(now, prior).firedRules.find((r) => r.id === 'pulse-elevated')
    expect(fired?.explanation).toContain(`usual ${usualLabel(trend!)?.replace('their usual ', '')}.`)
  })

  it('holds the same window the baseline does, fourteen usable check-ins back', () => {
    const prior = history(BASELINE_WINDOW_SESSIONS + 6)
    const trend = trendOf([...prior, latest()], P, 'pulse')
    expect(trend?.points.length).toBe(BASELINE_WINDOW_SESSIONS + 1)
    expect(trend?.points[0]?.id).toBe(prior[6]?.id)
  })

  it('draws no usual where the card would not quote one, and says so on the chart (#17)', () => {
    // HRV measured twice before: pulse has a usual, HRV does not.
    const prior = history(5).map((r, i) => ({ ...r, vitals: { ...r.vitals, hrvRmssdMs: i < 2 ? 40 : null } }))
    const records = [...prior, latest()]
    expect(trendOf(records, P, 'pulse')?.usual).not.toBeNull()
    const hrv = trendOf(records, P, 'hrv')
    expect(hrv?.usual).toBeNull()
    expect(hrv?.usualReadings).toBe(2)
    expect(hrv && usualLabel(hrv)).toBeNull()
    expect(hrv && trendNotes(hrv)[0]).toBe(
      'No usual for HRV yet — 2 of the 3 readings needed, so there is no line to compare with.',
    )
    // Still learning altogether: nothing to compare with for any metric.
    expect(trendOf([...history(2), latest()], P, 'pulse')?.usual).toBeNull()
  })

  it('leaves off check-ins it could not use, and says how many', () => {
    const prior = history(4)
    const records = [
      refused('r-old', '2026-08-01T09:00:00.000Z'), // before the window: not counted
      ...prior,
      refused('r-1', '2026-09-02T12:00:00.000Z'),
      refused('r-2', '2026-09-30T09:00:00.000Z'),
      latest(),
    ]
    const trend = trendOf(records, P, 'pulse')
    expect(trend?.points.map((p) => p.id)).not.toContain('r-1')
    expect(trend?.refused).toBe(2)
    expect(trend && trendNotes(trend)).toContain(
      '2 check-ins over this stretch could not be used, so they are not shown.',
    )
    // A refused capture after the latest usable one is not "the latest".
    const after = trendOf([...records, refused('r-3', '2026-10-02T09:00:00.000Z')], P, 'pulse')
    expect(after?.points.at(-1)?.id).toBe('latest')
  })

  it('says when the latest check-in did not measure this metric, rather than drawing a zero', () => {
    const trend = trendOf([...history(5), latest({ vitals: { hrvRmssdMs: null } })], P, 'hrv')
    expect(trend?.latestMeasured).toBe(false)
    expect(trend?.points.some((p) => p.latest)).toBe(false)
    expect(trend?.points.every((p) => p.value > 0)).toBe(true)
    expect(trend && trendNotes(trend)).toContain('HRV was not measured at the latest check-in.')
  })

  it('keeps seeded days marked as seeded, and says how many', () => {
    const mixed = trendOf([...seededHistory(4), ...history(2), latest()], P, 'pulse')
    expect(mixed?.points.filter((p) => p.seeded).length).toBe(4)
    expect(mixed?.seededPoints).toBe(4)
    expect(mixed && trendNotes(mixed)).toContain('4 of these points are seeded demo data, not measured.')
    const demo = trendOf(seededHistory(6), P, 'pulse')
    expect(demo && trendNotes(demo)).toContain('Every point here is seeded demo data, not measured.')
  })

  it('reads only this person, and nothing with no usable check-in', () => {
    const others = history(5).map((r) => ({ ...r, personId: 'someone-else' }))
    expect(trendOf(others, P, 'pulse')).toBeNull()
    expect(trendOf([refused('r', '2026-09-01T09:00:00.000Z')], P, 'pulse')).toBeNull()
    expect(trendOf([...others, latest()], P, 'pulse')?.points.map((p) => p.id)).toEqual(['latest'])
  })

  it('carries each point’s own zone, and none it does not have', () => {
    const zoned = latest({ timeZone: 'Europe/London' })
    expect(trendOf([zoned], P, 'pulse')?.points[0]?.timeZone).toBe('Europe/London')
    const { timeZone: _none, ...unzoned } = latest()
    expect(trendOf([unzoned], P, 'pulse')?.points[0]).not.toHaveProperty('timeZone')
  })
})

describe('what the chart says (KV-4)', () => {
  it('names what is plotted, the count and the unit', () => {
    const trend = trendOf([...history(5), latest()], P, 'breathing')
    expect(trend && trendTitle(trend)).toBe('Breathing rate, breaths/min, over the last 6 check-ins.')
    const one = trendOf([latest()], P, 'pulse')
    expect(one && trendTitle(one)).toBe('Pulse, bpm, at the latest check-in.')
  })

  it('says nothing relative to now', () => {
    const records = [...seededHistory(3), refused('r', '2026-09-01T12:00:00.000Z'), ...history(1), latest({ vitals: { hrvRmssdMs: null } })]
    for (const metric of ['pulse', 'breathing', 'hrv'] as const) {
      const trend = trendOf(records, P, metric)
      expect(trend).not.toBeNull()
      if (trend === null) continue
      for (const line of [trendTitle(trend), usualLabel(trend) ?? '', ...trendNotes(trend)]) {
        expect(line).not.toMatch(RELATIVE_TIME)
      }
    }
  })
})
