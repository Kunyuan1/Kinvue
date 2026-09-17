import { describe, expect, it } from 'vitest'
import {
  MAX_PAIN_NOTE_LENGTH,
  MAX_PERSON_ID_LENGTH,
  parseCheckInAnswers,
  parsePersonId,
} from '@core/session/validate'

const VALID = { mood: 'ok', sleep: 'well', eatenToday: true, painReported: false }

describe('parseCheckInAnswers', () => {
  it('accepts well-formed answers', () => {
    expect(parseCheckInAnswers(VALID)).toEqual(VALID)
  })

  it('keeps a pain note when pain was reported', () => {
    const answers = { ...VALID, painReported: true, painNote: 'left knee' }
    expect(parseCheckInAnswers(answers)).toEqual(answers)
  })

  it.each([
    ['not an object', 'ok'],
    ['null', null],
    ['an array', []],
    ['an unknown mood', { ...VALID, mood: 'great' }],
    ['an unknown sleep answer', { ...VALID, sleep: 'badly' }],
    ['a missing answer', { mood: 'ok', sleep: 'well', eatenToday: true }],
    ['a truthy string in place of a boolean', { ...VALID, eatenToday: 'yes' }],
    ['a non-string pain note', { ...VALID, painReported: true, painNote: 3 }],
    ['a pain note without pain reported', { ...VALID, painNote: 'left knee' }],
    ['an empty pain note', { ...VALID, painReported: true, painNote: '' }],
    ['a blank pain note', { ...VALID, painReported: true, painNote: '  ' }],
    [
      'an overlong pain note',
      { ...VALID, painReported: true, painNote: 'x'.repeat(MAX_PAIN_NOTE_LENGTH + 1) },
    ],
  ])('rejects %s', (_label, input) => {
    expect(parseCheckInAnswers(input)).toBeNull()
  })

  it('does not treat a missing answer as false', () => {
    // Missing is not zero: an absent eatenToday must not read as "has not eaten".
    const { eatenToday: _omitted, ...rest } = VALID
    expect(parseCheckInAnswers(rest)).toBeNull()
  })

  it('drops fields the caller added rather than storing them', () => {
    const parsed = parseCheckInAnswers({ ...VALID, seeded: true, severity: 0 })
    expect(parsed).toEqual(VALID)
    expect(parsed).not.toHaveProperty('seeded')
  })
})

describe('parsePersonId', () => {
  it('accepts a non-blank string', () => {
    expect(parsePersonId('demo-margaret')).toBe('demo-margaret')
  })

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['surrounding whitespace', ' demo-margaret'],
    ['an overlong id', 'x'.repeat(MAX_PERSON_ID_LENGTH + 1)],
    ['a number', 42],
    ['undefined', undefined],
  ])('rejects %s', (_label, input) => {
    expect(parsePersonId(input)).toBeNull()
  })
})
