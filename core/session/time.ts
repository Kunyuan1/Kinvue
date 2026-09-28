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

/**
 * A recorded zone that formatting can use, or undefined when there is none
 * to use: absent (before KV-28), empty, or one `Intl` does not know.
 *
 * Every place that shows a date in the zone it was taken calls this (review of
 * #162). `Intl` throws RangeError on `timeZone: ''` or an unknown zone, and
 * the store casts parsed JSON without checking what is inside a record, so an
 * unguarded reader turns one odd record into a render that throws — and, with
 * the chart drawn above the cards, a dashboard with nothing on it. Undefined
 * means "show it in the reader's zone", which is what a record with no zone
 * already gets; nothing is guessed into a different one.
 */
export function knownZone(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined || timeZone === '') return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return undefined
  }
}

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
