import type { CheckInAnswers, MoodAnswer, SleepAnswer } from './types'

/**
 * Runtime checks for data crossing from the renderer into the main process.
 * TypeScript types say nothing at runtime, and anything accepted here is scored
 * and written into the permanent history — so malformed input is rejected, not
 * repaired. A check-in that quietly fixed up its own answers would be storing
 * something nobody said.
 */

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
  if (painNote !== undefined && (typeof painNote !== 'string' || !painReported)) return null

  // Rebuilt field by field so nothing the caller added rides along into the store.
  const answers: CheckInAnswers = { mood, sleep, eatenToday, painReported }
  if (painNote !== undefined) answers.painNote = painNote
  return answers
}

/** The person id, or null if the input is not a non-blank string. */
export function parsePersonId(input: unknown): string | null {
  return typeof input === 'string' && input.trim() !== '' ? input : null
}
