import type { CheckInAnswers, MoodAnswer, SleepAnswer } from './types'

/**
 * The four questions' answers: turning a half-finished set into a check-in, or
 * refusing to, and saying what a finished set was (`describeAnswers`).
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


/** Each answer's value as the person chose it on the question screens. */
const MOOD: Record<MoodAnswer, string> = {
  good: 'good',
  ok: 'all right',
  low: 'low',
}

const SLEEP: Record<SleepAnswer, string> = {
  well: 'well',
  ok: 'all right',
  poorly: 'badly',
}

/** A stored value no table has words for reads as this, never as a blank. */
const NOT_RECORDED = 'not recorded'

const word = <K extends string>(table: Record<K, string>, value: unknown): string =>
  typeof value === 'string' && Object.hasOwn(table, value) ? table[value as K] : NOT_RECORDED

const yesNo = (value: unknown, yes: string, no: string): string =>
  value === true ? yes : value === false ? no : NOT_RECORDED

/** One label per question, keyed by `ANSWER_STEPS` so the order is the flow's. */
const LABEL: Record<(typeof ANSWER_STEPS)[number], (answers: CheckInAnswers) => string> = {
  mood: (a) => `mood ${word(MOOD, a.mood)}`,
  sleep: (a) => `sleep ${word(SLEEP, a.sleep)}`,
  eatenToday: (a) => `eaten ${yesNo(a.eatenToday, 'yes', 'not yet')}`,
  painReported: (a) => `pain ${yesNo(a.painReported, 'yes', 'no')}`,
}

/**
 * The four answers as a compact record, one label per question, in the order
 * they are asked (KV-110): "mood low", "sleep badly", "eaten not yet",
 * "pain yes".
 *
 * Shown on every card, whatever the answers were. Before this a card showed an
 * answer only when a rule fired on it, so a card with no sleep line could mean
 * they slept well, slept all right, or — on a record older than `poor-sleep` —
 * that nobody knows. A rule is the wrong tool for making something visible: it
 * also makes it weigh. So the answers are shown as a record, and the fired
 * rules go back to meaning "this counted".
 *
 * **Labels, not sentences** (KV-110 review). Sentences ("had not eaten yet")
 * repeated the rule titles word for word, so on the cards that matter the
 * caregiver read one fact two or three times, and "they said" put words in
 * the mouth of seeded demo data nobody spoke. A label is neither a rule nor a
 * quotation. The values are the person's own choices from the questions —
 * "all right", "badly", "not yet" — with no "today": the card's date says
 * when (KV-93). The pain note, when there is one, is shown on its own and
 * unedited; this only says whether there was pain.
 *
 * **An answer it cannot read says so.** Records read from disk are not
 * validated field by field, so a value outside these tables — a hand-edited
 * store, a record from another client — reads as "not recorded" rather than
 * vanishing from a row whose job is to leave nothing ambiguous.
 *
 * In `core/` rather than the card so the caregiver's client (#42) says the
 * same thing. Each table is keyed by its answer type, and the labels by
 * `ANSWER_STEPS`, so a new value or a new question does not compile without
 * words.
 */
export function describeAnswers(answers: CheckInAnswers): string[] {
  return ANSWER_STEPS.map((step) => LABEL[step](answers))
}
