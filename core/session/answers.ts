import type { CheckInAnswers, MoodAnswer, SleepAnswer, SessionRecord } from './types'

/**
 * A record with its answers as the questions are asked now (review of #167).
 *
 * Only a seeded one changes. A real check-in keeps the question it was asked:
 * "not yet" to "have you eaten today?" is not an answer to "have you skipped
 * any meals since yesterday?", and converting it would put words in a real
 * person's mouth. A seeded record is generated data, and KV-103 already
 * scores it by today's rules as a view, not a fact — so it is read as the
 * question asked now. The seed draws `skippedMeal` from the same number that
 * once drew `eatenToday` (`r() <= 0.1` is `!(r() > 0.1)`), so this is exactly
 * what a fresh seed writes: a demo seeded before KV-16 reads as one seeded
 * since, rather than showing "Had not eaten yet" forever for a person who does
 * not exist.
 *
 * A view, never a write: records are append-only, and the store applies this
 * only to what it lists.
 */
export function asAskedNow(record: SessionRecord): SessionRecord {
  if (record.seeded !== true) return record
  const { answers } = record
  if (answers.skippedMeal !== undefined || typeof answers.eatenToday !== 'boolean') return record
  const { eatenToday, ...rest } = answers
  return { ...record, answers: { ...rest, skippedMeal: !eatenToday } }
}

/**
 * The four questions' answers: turning a half-finished set into a check-in, or
 * refusing to, and saying what a finished set was (`describeAnswers`).
 *
 * A question nobody answered is not an answer, and it is certainly not a "no".
 * `CheckInAnswers` has no room for "not asked" — `skippedMeal: true` means the
 * person said they had skipped a meal, and `skipped-meal` fires a rule on it. So the
 * flow either collects all four or produces nothing, and this is where that is
 * decided rather than in the markup.
 */

/** Answers as the questions are being worked through. */
export interface AnswerDraft {
  mood?: MoodAnswer
  sleep?: SleepAnswer
  skippedMeal?: boolean
  painReported?: boolean
  painNote?: string
}

/** The four questions, in the order they are asked. */
export const ANSWER_STEPS = ['mood', 'sleep', 'skippedMeal', 'painReported'] as const

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
  const { mood, sleep, skippedMeal, painReported, painNote } = draft
  if (mood === undefined || sleep === undefined) return null
  if (skippedMeal === undefined || painReported === undefined) return null

  const answers: CheckInAnswers = { mood, sleep, skippedMeal, painReported }

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
  // The question the record was asked (KV-16): an older one keeps its own
  // words. The value is the button pressed, "No" or "Yes", as for pain — not a
  // paraphrase of it (review of #167).
  skippedMeal: (a) =>
    a.skippedMeal === undefined && a.eatenToday !== undefined
      ? `eaten ${yesNo(a.eatenToday, 'yes', 'not yet')}`
      : `skipped meals ${yesNo(a.skippedMeal, 'yes', 'no')}`,
  painReported: (a) => `pain ${yesNo(a.painReported, 'yes', 'no')}`,
}

/**
 * The four answers as a compact record, one label per question, in the order
 * they are asked (KV-110): "mood low", "sleep badly", "skipped meals yes",
 * "pain yes". A record from before KV-16 says "eaten yes" or "eaten not yet",
 * which is what it was asked.
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
 * "all right", "badly", "yes" — with no "today": the card's date says
 * when (KV-93). The pain note, when there is one, is shown on its own and
 * unedited; this only says whether there was pain.
 *
 * **An answer it cannot read says so.** A value outside these tables reads as
 * "not recorded" rather than vanishing from a row whose job is to leave nothing
 * ambiguous. Records read from disk are checked field by field since KV-181
 * (`checkRecord`), so one cannot reach here from the store; this stays for a
 * record that took another path — built in memory, or read by a viewer whose
 * own check it got past (review of #183).
 *
 * In `core/` rather than the card so the caregiver's client (#42) says the
 * same thing. Each table is keyed by its answer type, and the labels by
 * `ANSWER_STEPS`, so a new value or a new question does not compile without
 * words.
 */
export function describeAnswers(answers: CheckInAnswers): string[] {
  return ANSWER_STEPS.map((step) => LABEL[step](answers))
}
