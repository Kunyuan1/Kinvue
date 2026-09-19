import type { SessionRecord } from './types'

/**
 * Which local day a check-in belongs to.
 *
 * `capturedAt` is UTC, which is the right thing to store and not enough to
 * answer "was that today?" for the person who gave it. A check-in at 23:30 in
 * one zone is the next day in another, and once remote access exists the
 * caregiver reading it is often somewhere else entirely — the day has to be
 * theirs, not the reader's. See KV-28.
 */

/** The `YYYY-MM-DD` the capture happened on, where it happened. */
export function localDateOf(
  session: Pick<SessionRecord, 'capturedAt' | 'timeZone'>,
): string | null {
  const { capturedAt, timeZone } = session
  // No zone means no answer. A record written before KV-28 cannot be placed on
  // a local day, and guessing the reader's zone would put it on the wrong one
  // roughly whenever it matters.
  if (timeZone === undefined || timeZone === '') return null

  const at = new Date(capturedAt)
  if (Number.isNaN(at.getTime())) return null

  try {
    // en-CA formats as YYYY-MM-DD, which sorts and compares as a date should.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
  } catch {
    // Intl throws RangeError on a zone it does not know. A record carrying one
    // is damaged rather than undated, but the honest answer is still "unknown".
    return null
  }
}

/** True when both check-ins fall on the same local day for the person. */
export function onSameLocalDay(
  a: Pick<SessionRecord, 'capturedAt' | 'timeZone'>,
  b: Pick<SessionRecord, 'capturedAt' | 'timeZone'>,
): boolean {
  const dayA = localDateOf(a)
  return dayA !== null && dayA === localDateOf(b)
}
