import { describe, expect, it } from 'vitest'
import { answeredCount, draftToAnswers, type AnswerDraft } from '@core/session/answers'

/**
 * A question nobody answered is not an answer, and it is certainly not a "no".
 * `eatenToday: false` means the person said they had not eaten, and a rule
 * fires on it — so an unanswered question must not arrive as one (KV-2).
 */

const complete: AnswerDraft = {
  mood: 'ok',
  sleep: 'well',
  eatenToday: true,
  painReported: false,
}

describe('draftToAnswers', () => {
  it('returns the answers once all four questions are answered', () => {
    expect(draftToAnswers(complete)).toEqual(complete)
  })

  it('refuses a draft with any question unanswered', () => {
    for (const missing of ['mood', 'sleep', 'eatenToday', 'painReported'] as const) {
      const partial = { ...complete }
      delete partial[missing]
      expect(draftToAnswers(partial)).toBeNull()
    }
  })

  it('does not read an unanswered question as a no', () => {
    // The failure worth preventing: `eatenToday` absent becoming `false`, so
    // `not-eaten` fires about a question nobody put to them.
    const { eatenToday: _unanswered, ...rest } = complete
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
    expect(answeredCount({ eatenToday: false })).toBe(1)
  })
})
