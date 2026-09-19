import { describe, expect, it } from 'vitest'
import { localDateOf } from '@core/session/time'
import { session } from './helpers'

/**
 * The question these answer is "which day was this check-in?", asked from
 * somewhere else. Every case below is one a caregiver in another zone would
 * otherwise get wrong (KV-28).
 */

const at = (capturedAt: string, timeZone?: string): Parameters<typeof localDateOf>[0] =>
  timeZone === undefined ? { capturedAt } : { capturedAt, timeZone }

describe('localDateOf', () => {
  it('reports the day where the person was, not where the reader is', () => {
    // 23:30 on the 15th in London is still the 15th there, and already the 16th
    // in Tokyo. A caregiver in Tokyo must not be told this was yesterday.
    const capture = at('2026-09-15T22:30:00.000Z', 'Europe/London')

    expect(localDateOf(capture)).toBe('2026-09-15')
    expect(localDateOf(at('2026-09-15T22:30:00.000Z', 'Asia/Tokyo'))).toBe('2026-09-16')
  })

  it('crosses midnight with the person, not with UTC', () => {
    // 20:15 in New York on the 15th is 00:15 UTC on the 16th.
    expect(localDateOf(at('2026-09-16T00:15:00.000Z', 'America/New_York'))).toBe('2026-09-15')
  })

  it('places a check-in on the morning the clocks went forward', () => {
    // US DST begins 2026-03-08. 07:30Z is 02:30 EST, which that morning does
    // not exist — the clock jumps 02:00 to 03:00, so this is 03:30 EDT.
    expect(localDateOf(at('2026-03-08T07:30:00.000Z', 'America/New_York'))).toBe('2026-03-08')
    // The same instant is still the 8th in London, where DST starts weeks later.
    expect(localDateOf(at('2026-03-08T07:30:00.000Z', 'Europe/London'))).toBe('2026-03-08')
  })

  it('places a check-in on the night the clocks went back', () => {
    // 2026-11-01: 01:30 EDT and 01:30 EST are both real and an hour apart.
    expect(localDateOf(at('2026-11-01T05:30:00.000Z', 'America/New_York'))).toBe('2026-11-01')
    expect(localDateOf(at('2026-11-01T06:30:00.000Z', 'America/New_York'))).toBe('2026-11-01')
  })

  it('answers unknown for a record written before zones were recorded', () => {
    // Missing is not zero: guessing the reader's zone puts the check-in on the
    // wrong day precisely when the difference matters.
    expect(localDateOf(at('2026-09-15T22:30:00.000Z'))).toBeNull()
  })

  it('answers unknown rather than throwing on a damaged record', () => {
    expect(localDateOf(at('2026-09-15T22:30:00.000Z', 'Not/AZone'))).toBeNull()
    expect(localDateOf(at('not a timestamp', 'Europe/London'))).toBeNull()
  })

  it('reads the zone off a whole session record', () => {
    const record = { ...session(), timeZone: 'Europe/London' }
    expect(localDateOf(record)).toBe('2026-09-15')
  })
})
