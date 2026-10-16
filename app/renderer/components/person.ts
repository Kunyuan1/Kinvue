import { useEffect, useRef } from 'react'

/**
 * The cared-for person's path: Take a reading, the capture, the card that says
 * what it measured, and the four questions (KV-20).
 *
 * Everywhere else is the caregiver's, at a desk. These are read by an older
 * adult who may not have a steady hand or sharp eyes, so they are sized for
 * that, not for a developer's laptop: no text under 18px, no control under
 * 48px tall, and each control outlined in `--color-control`, which clears 3:1
 * where `--color-line` did not — a button drawn in the card's edge colour read
 * as text. Written once so the path cannot drift apart screen by screen.
 */

/**
 * Any control on the path. 48px tall, 18px text. Never disabled today, so it
 * carries no disabled style (review of #196): give it one with the first that
 * is, checked as `PERSON_PRIMARY`'s is.
 */
export const PERSON_BUTTON =
  'min-h-12 rounded-lg border-2 border-(--color-control) px-5 py-2 text-lg ' +
  'hover:border-(--color-ink)'

/**
 * The step forward: Take a reading, Finish. Outlined in ink, not grey, so its
 * hover cannot brighten the edge as `PERSON_BUTTON`'s does; it fills instead,
 * as both buttons did before KV-20 (review of #196). Disabled while Finish is
 * saving: ink at half opacity still clears 4.5:1, which
 * tests/accessibility.test.tsx computes rather than assumes.
 */
export const PERSON_PRIMARY =
  'min-h-12 rounded-lg border-2 border-(--color-ink) px-6 py-2 text-lg font-medium ' +
  'hover:bg-(--color-raised) disabled:opacity-50'

/** A line the person reads beside the main one: still 18px, only quieter. */
export const PERSON_NOTE = 'text-lg text-(--color-muted)'

/**
 * Moves focus to what the returned ref is set on when it appears, and again
 * whenever `key` changes — a screen opening, a question changing, a capture
 * turning into its failure. Without it the press that opened the screen leaves
 * focus on a button that is gone, and a screen reader starts again from the
 * top of a page that has changed under it.
 *
 * Only for a screen changing, never for something arriving on one: the
 * countdown and the framing advice are announced, not focused, so nothing
 * moves the person's place while they are being filmed.
 */
export function useFocusWhenShown<T extends HTMLElement>(key?: unknown): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [key])
  return ref
}
