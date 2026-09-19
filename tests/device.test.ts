import { describe, expect, it } from 'vitest'
import { usableTimeZone } from '../app/main/device'

/**
 * `core/session/time.ts` refuses to guess a zone when reading a record. This is
 * the same rule at the writing end: a guessed zone is indelible, and unlike a
 * record with no zone, nothing on it shows the guess was made (KV-28).
 */

describe('usableTimeZone', () => {
  it('records the zone the device resolved', () => {
    expect(usableTimeZone('Europe/London', -60)).toBe('Europe/London')
  })

  it('records UTC for a device that really is on UTC', () => {
    expect(usableTimeZone('UTC', 0)).toBe('UTC')
  })

  it('records nothing when Intl fell back to UTC on a device that is not', () => {
    // A container with no tzdata answers 'UTC' while the OS clock is offset.
    // Writing that would file a Tokyo morning on the previous day, for good.
    expect(usableTimeZone('UTC', -540)).toBeUndefined()
  })

  it('records nothing when there is no zone at all', () => {
    expect(usableTimeZone(undefined, 0)).toBeUndefined()
    expect(usableTimeZone('', 0)).toBeUndefined()
  })
})
