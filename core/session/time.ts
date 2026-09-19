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
    // Built from parts rather than by formatting with a locale that happens to
    // print YYYY-MM-DD: the output shape is then stated here instead of resting
    // on locale data an ICU update could reshape.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at)

    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((p) => p.type === type)?.value
    const year = part('year')
    const month = part('month')
    const day = part('day')
    if (year === undefined || month === undefined || day === undefined) return null

    return `${year}-${month}-${day}`
  } catch {
    // Intl throws RangeError on a zone it does not know. A record carrying one
    // is damaged rather than undated, but the honest answer is still "unknown".
    return null
  }
}
