import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { checkFormat, formatOf, RECORD_FORMAT, sameRecord } from '@core/session/format'
import { RECORD_POLICY } from '@core/share'
import type { SessionRecord } from '@core/session/types'
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
    // Every level reversed from the record itself, not rebuilt from literals, so
    // a changed default or a fifth question cannot make this fail for the wrong
    // reason (review of #182).
    const record = session({ timeZone: 'Europe/London' })
    const reverse = <T extends object>(o: T): T =>
      Object.fromEntries(Object.entries(o).reverse()) as T
    const reordered = reverse({
      ...record,
      answers: reverse(record.answers),
      vitals: reverse(record.vitals),
    })
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(record))
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

  it('reads only an absent format as unsaid: `null` is a value, not a format', () => {
    // Review of #182: `formatOf` read `null` as 1 while `checkFormat` refused it.
    const nulled = { ...session(), format: null } as unknown as SessionRecord
    expect(checkFormat(nulled)).toBe('unrecognised')
    expect(sameRecord(session(), nulled)).toBe(false)
  })

  it('is not the same record under another id, even with the same content', () => {
    expect(sameRecord(session({ id: 'a' }), session({ id: 'b' }))).toBe(false)
  })
})

describe('the format and what leaves are decided together (review of #182)', () => {
  /**
   * The share tables as data: every entry, nested tables and lists included.
   * A list's table sits under a symbol, which `Object.entries` does not see.
   */
  function shape(policy: object): unknown {
    const symbols = Object.getOwnPropertySymbols(policy)
    if (symbols.length > 0) return { list: shape((policy as Record<symbol, object>)[symbols[0]!]!) }
    return Object.fromEntries(
      Object.entries(policy).map(([key, entry]) => [
        key,
        typeof entry === 'object' ? shape(entry) : entry,
      ]),
    )
  }

  /** What leaves, pinned beside the format it leaves in. */
  const PINNED = { recordFormat: 1, sharedShape: '8d7dbffdcac9814f' }

  it('fails when what leaves changes, until someone decides whether the format must move', () => {
    const sharedShape = createHash('sha256')
      .update(JSON.stringify(shape(RECORD_POLICY)))
      .digest('hex')
      .slice(0, 16)
    expect(
      { recordFormat: RECORD_FORMAT, sharedShape },
      'What leaves the device has changed. Decide whether a viewer reading the old shared ' +
        'shape would misread the new one: if so, bump RECORD_FORMAT in core/session/format.ts. ' +
        'Either way, update PINNED here to the new values.',
    ).toEqual(PINNED)
  })
})
