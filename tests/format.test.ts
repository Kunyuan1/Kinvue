import { describe, expect, it } from 'vitest'
import { checkFormat, formatOf, RECORD_FORMAT, sameRecord } from '@core/session/format'
import { session } from './helpers'

/**
 * What a record says about itself, so it makes sense wherever it lands (KV-30).
 */

describe('the record format (KV-30)', () => {
  it('is 1, and a record from before KV-30 is read as that without being changed', () => {
    expect(RECORD_FORMAT).toBe(1)
    const before = session()
    expect(before).not.toHaveProperty('format')
    expect(formatOf(before)).toBe(1)
    expect(before).not.toHaveProperty('format')
    expect(formatOf(session({ format: 1 }))).toBe(1)
  })

  it('reads every format up to its own, refuses a newer one, and names a broken one', () => {
    expect(checkFormat({})).toBe('readable')
    expect(checkFormat({ format: 1 })).toBe('readable')
    expect(checkFormat({ format: RECORD_FORMAT + 1 })).toBe('newer')
    for (const broken of [0, -1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkFormat({ format: broken }), String(broken)).toBe('unrecognised')
    }
  })
})

describe('sameRecord: one record arriving twice is one record (KV-30)', () => {
  it('is the same record when the id and everything under it match', () => {
    expect(sameRecord(session(), session())).toBe(true)
  })

  it('ignores key order, which is not part of what a record says', () => {
    const record = session({ timeZone: 'Europe/London' })
    const reordered = JSON.parse(
      JSON.stringify({
        answers: { painReported: false, skippedMeal: false, sleep: 'well', mood: 'good' },
        vitals: Object.fromEntries(Object.entries(record.vitals).reverse()),
        timeZone: record.timeZone,
        capturedAt: record.capturedAt,
        personId: record.personId,
        id: record.id,
      }),
    )
    expect(sameRecord(record, reordered)).toBe(true)
  })

  it('is not the same record when anything under the id differs, however small', () => {
    const record = session()
    expect(sameRecord(record, session({ vitals: { pulseRateBpm: 73 } }))).toBe(false)
    expect(sameRecord(record, session({ answers: { painReported: true } }))).toBe(false)
    expect(sameRecord(record, { ...record, seeded: true })).toBe(false)
  })

  it('reads a format left unsaid as 1, as everywhere else, and not as a difference', () => {
    expect(sameRecord(session(), session({ format: 1 }))).toBe(true)
    expect(sameRecord(session(), session({ format: 2 }))).toBe(false)
  })

  it('is not the same record under another id, even with the same content', () => {
    expect(sameRecord(session({ id: 'a' }), session({ id: 'b' }))).toBe(false)
  })
})
