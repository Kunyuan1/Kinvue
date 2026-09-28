import { describe, expect, it } from 'vitest'
import { BASELINE_WINDOW_SESSIONS, computeBaseline } from '@core/baseline'
import { scoreSession } from '@core/scoring'
import { axisTicks, trendNotes, trendOf, trendTitle, usualLabel } from '@core/trend'
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
    expect(trend && trendTitle(trend)).toBe('Breathing, br/min, over the last 6 check-ins.')
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

describe('axisTicks: round values to read a point against (KV-4)', () => {
  it('gives a narrow range three or more ticks — the two seen on screen with one or two', () => {
    // Breathing 14–19 around a usual of 15, padded as the chart pads it.
    expect(axisTicks(13.25, 19.75)).toEqual([14, 16, 18])
    // HRV 24–38 around 34: 24 now sits beside a tick, not under the lowest.
    expect(axisTicks(21.9, 40.1)).toEqual([25, 30, 35, 40])
  })

  it('never gives more than five, at any scale', () => {
    for (const [lo, hi] of [[0, 1], [60, 110], [0.2, 0.9], [0, 1000], [71.5, 72.5]] as const) {
      const ticks = axisTicks(lo, hi)
      expect(ticks.length, `${lo}–${hi}`).toBeGreaterThanOrEqual(2)
      expect(ticks.length, `${lo}–${hi}`).toBeLessThanOrEqual(5)
      for (const t of ticks) expect(t >= lo && t <= hi, `${t} in ${lo}–${hi}`).toBe(true)
    }
  })

  it('keeps decimal ticks clean', () => {
    expect(axisTicks(0.2, 0.9)).toEqual([0.2, 0.4, 0.6, 0.8])
  })

  it('does not loop on an empty range', () => {
    expect(axisTicks(5, 5)).toEqual([5])
  })
})

describe('what the chart spans, and says about it (review of #162)', () => {
  const day = (d: number, over: Parameters<typeof session>[0] = {}): SessionRecord =>
    session({ id: `d-${d}`, capturedAt: new Date(Date.UTC(2026, 8, d, 9)).toISOString(), ...over })

  it('counts refusals over the stretch drawn, not the window behind it (finding 2)', () => {
    // 14 usable check-ins Sep 1–14, HRV on Sep 13–14 only; refusals Sep 2 and 3.
    const usable = Array.from({ length: 14 }, (_, i) =>
      day(i + 1, { vitals: { hrvRmssdMs: i >= 12 ? 40 : null } }),
    )
    const records = [
      ...usable,
      refused('r-2', '2026-09-02T12:00:00.000Z'),
      refused('r-3', '2026-09-03T12:00:00.000Z'),
      latest({ vitals: { hrvRmssdMs: 38 } }),
    ]
    const hrv = trendOf(records, P, 'hrv')
    expect(hrv?.points[0]?.capturedAt.slice(0, 10)).toBe('2026-09-13')
    expect(hrv?.refused).toBe(0)
    // On Pulse, where Sep 1 is drawn, the same two are in the stretch.
    expect(trendOf(records, P, 'pulse')?.refused).toBe(2)
  })

  it('counts readings and check-ins apart, and never claims the latest for an older reading (finding 3)', () => {
    // Three usable check-ins, HRV on the first only; the latest measured none.
    const records = [
      day(1, { vitals: { hrvRmssdMs: 40 } }),
      day(2, { vitals: { hrvRmssdMs: null } }),
      day(3, { vitals: { hrvRmssdMs: null } }),
      latest({ vitals: { hrvRmssdMs: null } }),
    ]
    const hrv = trendOf(records, P, 'hrv')
    expect(hrv && trendTitle(hrv)).toBe('HRV, ms: 1 reading over the last 4 check-ins.')
    expect(hrv && trendNotes(hrv)).toContain('HRV was not measured at the latest check-in.')
    // Fourteen check-ins, HRV on three of them.
    const sparse = Array.from({ length: 13 }, (_, i) =>
      day(i + 1, { vitals: { hrvRmssdMs: i >= 11 ? 40 : null } }),
    )
    // Consecutive readings: as many readings as check-ins, so said once.
    const three = trendOf([...sparse, latest()], P, 'hrv')
    expect(three && trendTitle(three)).toBe('HRV, ms, over the last 3 check-ins.')
    const wide = [...sparse.map((r, i) => (i === 0 ? { ...r, vitals: { ...r.vitals, hrvRmssdMs: 40 } } : r)), latest()]
    const spanned = trendOf(wide, P, 'hrv')
    expect(spanned && trendTitle(spanned)).toBe('HRV, ms: 4 readings over the last 14 check-ins.')
  })

  it('says, under a lone first point, that the check-ins before it could not be used (finding 4)', () => {
    const records = [
      refused('r-28', '2026-09-28T09:00:00.000Z'),
      refused('r-29', '2026-09-29T09:00:00.000Z'),
      refused('r-30', '2026-09-30T09:00:00.000Z'),
      latest(),
    ]
    const trend = trendOf(records, P, 'pulse')
    expect(trend?.refused).toBe(3)
    expect(trend && trendNotes(trend)).toContain(
      '3 check-ins before it could not be used, so they are not shown.',
    )
    expect(trend && trendTitle(trend)).toBe('Pulse, bpm, at the latest check-in.')
  })

  it('says first when the newest check-in could not be used (design B)', () => {
    const records = [...history(4), latest(), refused('r-new', '2026-10-02T09:00:00.000Z')]
    const trend = trendOf(records, P, 'pulse')
    expect(trend?.refusedSince).toBe(1)
    expect(trend && trendNotes(trend)[0]).toBe(
      'The most recent check-in could not be used, so the latest point here is an earlier one.',
    )
    const two = trendOf([...records, refused('r-newer', '2026-10-03T09:00:00.000Z')], P, 'pulse')
    expect(two && trendNotes(two)[0]).toMatch(/^The 2 most recent check-ins could not be used/)
    // And not counted as "over this stretch" too.
    expect(two?.refused).toBe(0)
  })

  it('says "latest" and "the last" only while no check-in in or after the stretch was refused (second review of #162)', () => {
    // Refused Sep 28, usable Oct 1, refused Oct 2: the one point is not the latest check-in.
    const lone = trendOf(
      [refused('r-28', '2026-09-28T09:00:00.000Z'), latest(), refused('r-new', '2026-10-02T09:00:00.000Z')],
      P,
      'pulse',
    )
    expect(lone && trendTitle(lone)).toBe('Pulse, bpm, at the latest check-in that could be used.')
    expect(lone && trendNotes(lone)[0]).toMatch(/^The most recent check-in could not be used/)

    // Five usable, two refused among them: not "the last 5".
    const five = [...history(4), latest()]
    const within = trendOf(
      [...five, refused('r-2', '2026-09-02T12:00:00.000Z'), refused('r-3', '2026-09-03T12:00:00.000Z')],
      P,
      'pulse',
    )
    expect(within && trendTitle(within)).toBe('Pulse, bpm, over 5 check-ins that could be used.')
    const after = trendOf([...five, refused('r-new', '2026-10-02T09:00:00.000Z')], P, 'pulse')
    expect(after && trendTitle(after)).toBe('Pulse, bpm, over 5 check-ins that could be used.')
    // Readings counted apart still read the same way.
    const sparse = trendOf(
      [...history(3), day(4, { vitals: { pulseRateBpm: null } }), latest(), refused('r-new', '2026-10-02T09:00:00.000Z')],
      P,
      'pulse',
    )
    expect(sparse && trendTitle(sparse)).toBe('Pulse, bpm: 4 readings over 5 check-ins that could be used.')
    // Nothing refused: unchanged.
    expect(trendTitle(trendOf(five, P, 'pulse')!)).toBe('Pulse, bpm, over the last 5 check-ins.')
  })
})
