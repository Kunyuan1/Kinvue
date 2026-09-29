import { describe, expect, it } from 'vitest'
import {
  ANSWER_STEPS,
  answeredCount,
  describeAnswers,
  draftToAnswers,
  type AnswerDraft,
} from '@core/session/answers'
import type { CheckInAnswers } from '@core/session/types'

/**
 * A question nobody answered is not an answer, and it is certainly not a "no".
 * `skippedMeal: true` means the person said they had skipped a meal, and a rule
 * fires on it — so an unanswered question must not arrive as an answer (KV-2).
 */

const complete: AnswerDraft = {
  mood: 'ok',
  sleep: 'well',
  skippedMeal: false,
  painReported: false,
}

describe('draftToAnswers', () => {
  it('returns the answers once all four questions are answered', () => {
    expect(draftToAnswers(complete)).toEqual(complete)
  })

  it('refuses a draft with any question unanswered', () => {
    for (const missing of ['mood', 'sleep', 'skippedMeal', 'painReported'] as const) {
      const partial = { ...complete }
      delete partial[missing]
      expect(draftToAnswers(partial)).toBeNull()
    }
  })

  it('does not read an unanswered question as a no', () => {
    // The failure worth preventing: `skippedMeal` absent arriving as an
    // answer, so a rule reads a question nobody put to them.
    const { skippedMeal: _unanswered, ...rest } = complete
    expect(draftToAnswers(rest)).toBeNull()
  })

  it('keeps a pain note alongside the pain it describes', () => {
    const answers = draftToAnswers({ ...complete, painReported: true, painNote: 'left hip' })
    expect(answers?.painNote).toBe('left hip')
  })

  it('drops a note that is only whitespace', () => {
    // Typed and deleted is not a note. "No note" has one shape — absent — and
    // the process boundary rejects an empty string outright.
    const answers = draftToAnswers({ ...complete, painReported: true, painNote: '   ' })
    expect(answers).not.toHaveProperty('painNote')
  })

  it('trims what it keeps', () => {
    const answers = draftToAnswers({ ...complete, painReported: true, painNote: '  knee \n' })
    expect(answers?.painNote).toBe('knee')
  })

  it('drops a note when no pain was reported', () => {
    // A note without pain is rejected downstream; guessing which half was meant
    // would invent an answer.
    const answers = draftToAnswers({ ...complete, painReported: false, painNote: 'knee' })
    expect(answers).not.toHaveProperty('painNote')
  })
})

describe('answeredCount', () => {
  it('counts only questions that have been answered', () => {
    expect(answeredCount({})).toBe(0)
    expect(answeredCount({ mood: 'low' })).toBe(1)
    expect(answeredCount(complete)).toBe(4)
  })

  it('counts a false answer as answered', () => {
    expect(answeredCount({ skippedMeal: false })).toBe(1)
  })
})

describe('describeAnswers (KV-110)', () => {
  const all: CheckInAnswers = { mood: 'good', sleep: 'well', skippedMeal: false, painReported: false }

  it('labels every answer, including the ones no rule fires on', () => {
    expect(describeAnswers(all)).toEqual(['mood good', 'sleep well', 'skipped meals no', 'pain no'])
  })

  it('labels a record from before KV-16 with the question it was asked', () => {
    const before = { mood: 'good', sleep: 'well', eatenToday: false, painReported: false } as const
    expect(describeAnswers(before)[2]).toBe('eaten not yet')
    expect(describeAnswers({ ...before, eatenToday: true })[2]).toBe('eaten yes')
  })

  it("uses the person's own choices from the questions", () => {
    expect(
      describeAnswers({ mood: 'ok', sleep: 'poorly', skippedMeal: true, painReported: true }),
    ).toEqual(['mood all right', 'sleep badly', 'skipped meals yes', 'pain yes'])
    expect(describeAnswers({ ...all, mood: 'low', sleep: 'ok' }).slice(0, 2)).toEqual([
      'mood low',
      'sleep all right',
    ])
  })

  it('gives one label per question, in the order they are asked', () => {
    // Positional, not just a count (KV-110 review): reorder ANSWER_STEPS and
    // the row must follow.
    const topic = { mood: 'mood', sleep: 'sleep', skippedMeal: 'skipped', painReported: 'pain' }
    expect(describeAnswers(all).map((label) => label.split(' ')[0])).toEqual(
      ANSWER_STEPS.map((step) => topic[step]),
    )
  })

  it('says "not recorded" for a stored value it has no words for, never a blank', () => {
    // Records read from disk are not validated field by field (KV-110 review).
    const odd = { mood: 'ecstatic', sleep: undefined, skippedMeal: 'yes', painReported: null }
    expect(describeAnswers(odd as unknown as CheckInAnswers)).toEqual([
      'mood not recorded',
      'sleep not recorded',
      'skipped meals not recorded',
      'pain not recorded',
    ])
    // An older record's answer the same way, and one with neither.
    const { skippedMeal: _, ...oddBefore } = odd
    const oldOdd = { ...oddBefore, eatenToday: 'yes' }
    expect(describeAnswers(oldOdd as unknown as CheckInAnswers)[2]).toBe('eaten not recorded')
    const neither = oddBefore
    expect(describeAnswers(neither as unknown as CheckInAnswers)[2]).toBe('skipped meals not recorded')
  })

  it('does not say when, quote the pain note, or attribute speech', () => {
    // The card's date says when (KV-93); the note is shown on its own, unedited;
    // and a label is not a quotation, so a seeded card is not given words.
    const text = describeAnswers({ ...all, painReported: true, painNote: 'left hip' }).join(' ')
    expect(text).not.toMatch(/today|yesterday|this morning|left hip|said|reported/i)
  })
})
