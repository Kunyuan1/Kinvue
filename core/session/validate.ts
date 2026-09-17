import type { CheckInAnswers, MoodAnswer, SleepAnswer } from './types'

/**
 * Runtime checks for data crossing from the renderer into the main process.
 * TypeScript types say nothing at runtime, and anything accepted here is scored
 * and written into the permanent history — so malformed input is rejected, not
 * repaired. A check-in that quietly fixed up its own answers would be storing
 * something nobody said.
 */

/**
 * Generous caps, not product limits. Whatever passes is written to a file that
 * is re-read and rewritten in full on every append, so a renderer bug that sends
 * a pasted log should be rejected rather than stored.
 */
export const MAX_PAIN_NOTE_LENGTH = 2000
export const MAX_PERSON_ID_LENGTH = 128

const MOODS: readonly MoodAnswer[] = ['good', 'ok', 'low']
const SLEEPS: readonly SleepAnswer[] = ['well', 'ok', 'poorly']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const oneOf = <T extends string>(options: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (options as readonly string[]).includes(v)

/** The answers, or null if the input is not a valid `CheckInAnswers`. */
export function parseCheckInAnswers(input: unknown): CheckInAnswers | null {
  if (!isRecord(input)) return null
  const { mood, sleep, eatenToday, painReported, painNote } = input

  if (!oneOf(MOODS, mood) || !oneOf(SLEEPS, sleep)) return null
  if (typeof eatenToday !== 'boolean' || typeof painReported !== 'boolean') return null

  // The note is only collected when pain was reported. A note without pain is
  // a caller bug, and guessing which half is wrong would be inventing an answer.
  // A blank note is rejected too: "no note" has one shape, an absent field, and
  // trimming a blank one away would be repairing the input.
  if (painNote !== undefined) {
    if (typeof painNote !== 'string' || !painReported) return null
    if (painNote.trim() === '' || painNote.length > MAX_PAIN_NOTE_LENGTH) return null
  }

  // Rebuilt field by field so nothing the caller added rides along into the store.
  const answers: CheckInAnswers = { mood, sleep, eatenToday, painReported }
  if (painNote !== undefined) answers.painNote = painNote
  return answers
}

/**
 * The person id, or null if the input is not a non-blank string without
 * surrounding whitespace. The store matches ids exactly, so `' demo-margaret'`
 * would quietly become a second person with no history.
 */
export function parsePersonId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (input === '' || input.trim() !== input || input.length > MAX_PERSON_ID_LENGTH) return null
  return input
}
