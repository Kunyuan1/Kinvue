import { expect } from 'vitest'

/** Tailwind's text sizes, smallest first; the path's floor is `text-lg`, 18px. */
const SIZE = /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b/
const AT_LEAST_18PX = new Set(['lg', 'xl', '2xl', '3xl', '4xl'])

/**
 * Nothing on the cared-for person's path under the path's own sizes (KV-20):
 * every button at least 48px tall (`min-h-12`, or an answer's `min-h-16`), and
 * every piece of text on screen set at 18px or more — by its own class or by
 * the nearest ancestor's within `root`.
 *
 * Asserted by presence, not absence (review of #196). Checking only that no
 * `text-sm` appears passed a line with no size class at all, which inherits
 * the page's 16px: under the floor, and green. Text that is only spoken
 * (`sr-only`) has no size anyone sees, so it is not held to one.
 *
 * By class because jsdom lays nothing out; the numbers behind the classes are
 * the decision in `app/renderer/components/person.ts`.
 */
export function expectPersonSized(root: Element): void {
  const buttons = root.querySelectorAll('button')
  expect(buttons.length).toBeGreaterThan(0)
  for (const button of buttons) {
    expect(button.className, button.textContent ?? '').toMatch(/\bmin-h-1[26]\b/)
  }

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let checked = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? ''
    const parent = node.parentElement
    if (text === '' || parent === null || parent.closest('.sr-only') !== null) continue
    let size: string | undefined
    for (let at: Element | null = parent; at !== null; at = at.parentElement) {
      size = SIZE.exec(at.getAttribute('class') ?? '')?.[1]
      if (size !== undefined || at === root) break
    }
    expect(size === undefined ? 'no size (16px)' : `text-${size}`, `"${text}"`).toSatisfy(
      (found: string) => AT_LEAST_18PX.has(found.replace('text-', '')),
    )
    checked++
  }
  expect(checked).toBeGreaterThan(0)
}
