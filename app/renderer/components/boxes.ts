/**
 * The box each dashboard section is drawn in, shared by the section and by
 * the gap it leaves when it cannot be drawn (KV-163). Written once so the two
 * stay one shape: copied, a restyled card would leave a failed one a different
 * box mid-list, and nothing would say so until a card failed (review of #164).
 */

/** A check-in card. */
export const CARD_BOX = 'rounded-xl border border-(--color-line) bg-(--color-raised) p-5'

/** The trend, above the cards. */
export const CHART_BOX = `mb-8 ${CARD_BOX}`
