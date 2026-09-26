import type { CheckInAnswers, MoodAnswer, SleepAnswer } from './types'

/**
 * Turning a half-finished set of answers into a check-in, or refusing to.
 *
 * A question nobody answered is not an answer, and it is certainly not a "no".
 * `CheckInAnswers` has no room for "not asked" — `eatenToday: false` means the
 * person said they had not eaten, and `not-eaten` fires a rule on it. So the
 * flow either collects all four or produces nothing, and this is where that is
 * decided rather than in the markup.
 */

/** Answers as the questions are being worked through. */
export interface AnswerDraft {
  mood?: MoodAnswer
  sleep?: SleepAnswer
  eatenToday?: boolean
  painReported?: boolean
  painNote?: string
}

/** The four questions, in the order they are asked. */
export const ANSWER_STEPS = ['mood', 'sleep', 'eatenToday', 'painReported'] as const

/** How many of the four have been answered. */
export function answeredCount(draft: AnswerDraft): number {
  return ANSWER_STEPS.filter((step) => draft[step] !== undefined).length
}

/**
 * The completed answers, or null while any question is still unanswered.
 *
 * A blank pain note is dropped rather than stored: "no note" has one shape, an
 * absent field, and `core/session/validate.ts` rejects an empty one at the
 * process boundary. Whitespace someone typed and deleted is not a note.
 */
export function draftToAnswers(draft: AnswerDraft): CheckInAnswers | null {
  const { mood, sleep, eatenToday, painReported, painNote } = draft
  if (mood === undefined || sleep === undefined) return null
  if (eatenToday === undefined || painReported === undefined) return null

  const answers: CheckInAnswers = { mood, sleep, eatenToday, painReported }

  // Only ever kept alongside the pain it describes; a note without pain is
  // rejected downstream, and guessing which half was meant would invent one.
  if (painReported && painNote !== undefined && painNote.trim() !== '') {
    answers.painNote = painNote.trim()
  }
  return answers
}

/**
 * What they said, one short phrase per question, in the order they were asked
 * (KV-110).
 *
 * Shown on every card, whatever the answers were. Before this a card showed an
 * answer only when a rule fired on it, so a card with no sleep line could mean
 * they slept well, slept all right, or — on a record older than `poor-sleep` —
 * that nobody knows. A rule is the wrong tool for making something visible: it
 * also makes it weigh. So the answers are shown here, and the fired rules go
 * back to meaning "this counted".
 *
 * The words are the person's own choices from the questions — "all right",
 * "badly", "not yet" — put in the third person for whoever reads the card, and
 * with no "today": the card's date says when (KV-93). They report what was
 * said, not a verdict on it. The pain note, when there is one, is shown on its
 * own and unedited; this only says whether there was pain.
 *
 * In `core/` rather than the card so the caregiver's client (#42) says the
 * same thing. Each table is keyed by the answer's type, so a new value does
 * not compile until it has words.
 */
const MOOD: Record<MoodAnswer, string> = {
  good: 'feeling good',
  ok: 'feeling all right',
  low: 'feeling low',
}

const SLEEP: Record<SleepAnswer, string> = {
  well: 'slept well',
  ok: 'slept all right',
  poorly: 'slept badly',
}

export function describeAnswers(answers: CheckInAnswers): string[] {
  return [
    MOOD[answers.mood],
    SLEEP[answers.sleep],
    answers.eatenToday ? 'had eaten' : 'had not eaten yet',
    answers.painReported ? 'in pain' : 'no pain',
  ]
}
