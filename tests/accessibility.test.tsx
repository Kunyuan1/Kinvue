// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CaptureFailure } from '@core/capture/failure'
import CaptureScreen, { COUNTDOWN_ANNOUNCE_DELAY_MS } from '@renderer/components/CaptureScreen'
import QuestionFlow from '@renderer/components/QuestionFlow'
import { PERSON_PRIMARY } from '@renderer/components/person'
import { expectPersonSized } from './person-sized'

/**
 * The cared-for person's path, held to what KV-20 decided: contrast measured
 * from the theme itself, sizes no smaller than the path's own, focus that
 * follows the screen, and a capture that announces without moving anyone.
 *
 * jsdom has no layout, so sizes are asserted by the classes that set them —
 * the only way a DOM test can see them — and the numbers behind those classes
 * are the decision recorded in `components/person.ts`.
 */

const STYLES = readFileSync(join(__dirname, '../app/renderer/styles.css'), 'utf-8')

/** A theme token's value, read out of `styles.css` so the test checks what ships. */
const token = (name: string): string => {
  const value = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6});`).exec(STYLES)?.[1]
  if (value === undefined) throw new Error(`no --color-${name} in styles.css`)
  return value
}

/** WCAG 2 relative luminance and contrast ratio. */
const luminance = (hex: string): number => {
  const channel = (at: number): number => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('the theme’s contrast (KV-20)', () => {
  const surfaces = ['ground', 'raised']

  it('measures what it should: the formula agrees with a known pair', () => {
    // White on black is 21:1 by definition; a broken formula passes everything.
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
  })

  // Every colour text is drawn in. `unknown` among them: it is the colour of
  // "Nothing was measured" and of a card's verdict, and was 3.7:1.
  it.each(['ink', 'muted', 'normal', 'elevated', 'unknown'])(
    '--color-%s is readable text on every surface, 4.5:1',
    (name) => {
      for (const surface of surfaces) {
        expect(contrast(token(name), token(surface)), surface).toBeGreaterThanOrEqual(4.5)
      }
    },
  )

  // What says "this can be pressed", and where the keyboard is: 3:1, the
  // minimum for a control's boundary and a focus indicator.
  it.each(['control', 'focus'])('--color-%s is visible against every surface, 3:1', (name) => {
    for (const surface of surfaces) {
      expect(contrast(token(name), token(surface)), surface).toBeGreaterThanOrEqual(3)
    }
  })

  it('draws a focus ring from the focus colour, for the keyboard only', () => {
    expect(STYLES).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-focus\)/)
  })

  it('keeps Finish readable while it says Saving…, at half opacity (review of #196)', () => {
    // `disabled:opacity-50` on PERSON_PRIMARY. A hex token cannot show this:
    // the text is drawn half-transparent over whatever surface it sits on.
    const blend = (fg: string, bg: string, alpha: number): string =>
      '#' +
      [1, 3, 5]
        .map((at) => {
          const [f, b] = [fg, bg].map((hex) => parseInt(hex.slice(at, at + 2), 16))
          return Math.round(alpha * (f ?? 0) + (1 - alpha) * (b ?? 0))
            .toString(16)
            .padStart(2, '0')
        })
        .join('')
    expect(PERSON_PRIMARY).toMatch(/\bdisabled:opacity-50\b/)
    for (const surface of surfaces) {
      const faded = blend(token('ink'), token(surface), 0.5)
      expect(contrast(faded, token(surface)), surface).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('marks a focused heading differently, never not at all (review of #196)', () => {
    expect(STYLES).toMatch(
      /:is\(h1, h2\)\[tabindex='-1'\]:focus-visible\s*\{[^}]*outline:\s*2px dashed var\(--color-focus\)/,
    )
    // Nothing takes the ring away. A rule keyed on tabindex alone did, and
    // would have from any control later taken out of the tab order too.
    expect(STYLES).not.toMatch(/outline:\s*(none|0)\b/)
  })
})

describe('the questions, walked without a mouse (KV-20)', () => {
  const renderQuestions = (failure: Parameters<typeof QuestionFlow>[0]['failure'] = null) =>
    render(
      <QuestionFlow
        onDone={() => undefined}
        onCancel={() => undefined}
        submitting={false}
        failure={failure}
      />,
    )

  afterEach(cleanup)

  it('puts focus on each question as it opens, and on the one gone back to', () => {
    renderQuestions()
    const first = screen.getByRole('heading', { name: 'How are you feeling today?' })
    expect(document.activeElement).toBe(first)

    fireEvent.click(screen.getByRole('button', { name: 'Good' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'How did you sleep?' }))

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'How are you feeling today?' }),
    )
  })

  it('reads the question’s place in the four with it', () => {
    renderQuestions()
    const heading = screen.getByRole('heading', { name: 'How are you feeling today?' })
    const describedBy = heading.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.textContent).toBe('Question 1 of 4')
  })

  it('names each group of answers by its question', () => {
    renderQuestions()
    const group = screen.getByRole('group', { name: 'How are you feeling today?' })
    expect(group.querySelectorAll('button')).toHaveLength(3)
  })

  it('marks the chosen answer with a tick and aria-pressed, not by colour alone', () => {
    renderQuestions()
    fireEvent.click(screen.getByRole('button', { name: 'Low' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    const chosen = screen.getByRole('button', { name: 'Low' })
    expect(chosen.getAttribute('aria-pressed')).toBe('true')
    expect(chosen.textContent).toContain('✓')
    // The tick is for the eye; aria-pressed already says it to a screen reader.
    expect(chosen.querySelector('[aria-hidden="true"]')?.textContent).toBe('✓')

    const other = screen.getByRole('button', { name: 'Good' })
    expect(other.getAttribute('aria-pressed')).toBe('false')
    expect(other.textContent).not.toContain('✓')
  })

  /** The last question's live region: the only polite one on these screens. */
  const toLastQuestion = (): Element => {
    renderQuestions()
    for (const answer of ['Good', 'Well', 'No']) {
      fireEvent.click(screen.getByRole('button', { name: answer }))
    }
    screen.getByRole('heading', { name: 'Are you in any pain today?' })
    const live = document.querySelector('[aria-live="polite"]')
    if (live === null) throw new Error('no live region on the last question')
    // There before anything is said into it, so what is said is heard.
    expect(live.textContent).toBe('')
    return live
  }

  it('says aloud that the questions are over, and where Finish is, when the last answer is No', () => {
    const live = toLastQuestion()
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(live.textContent).toBe('Good. That is everything. Finish is below.')
    // Only the first sentence is on screen; where Finish is, the eye can see.
    expect(live.querySelector('.sr-only')?.textContent).toBe(' Finish is below.')
  })

  it('keeps the empty region out of the layout: outside the answers, no margin, no content', () => {
    // Inside the group it took the group's spacing while empty, and the row
    // below sat 12px lower on this question than on the others (review of #196).
    const live = toLastQuestion()
    expect(live.closest('[role="group"]')).toBeNull()
    expect(live.childNodes).toHaveLength(0)
    expect(live.className).toMatch(/\bempty:mt-0\b/)
  })

  it('says so for Yes too, and that a box for the note has opened (review of #196)', () => {
    const live = toLastQuestion()
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(live.textContent).toMatch(/^That is everything\. Below is a box to say where/)
    expect(live.textContent).toMatch(/not required\. Finish is after it\.$/)
    // All of it spoken-only: the box and its label are on screen already.
    expect(live.querySelector('.sr-only')?.textContent).toBe(live.textContent)
  })

  it('announces a failure to save, which appears where focus already is', () => {
    renderQuestions('unknown')
    expect(screen.getByRole('alert').textContent).toMatch(/could not be saved/)
  })

  it('draws every control and line at the path’s sizes', () => {
    const { container } = renderQuestions('unknown')
    expectPersonSized(container)
    // The last question too: the note's label, and Finish once it appears.
    for (const answer of ['Good', 'Well', 'No', 'Yes']) {
      fireEvent.click(screen.getByRole('button', { name: answer }))
    }
    expect(screen.getByRole('button', { name: 'Finish' })).toBeDefined()
    expect(screen.getByRole('textbox')).toBeDefined()
    expectPersonSized(container)
  })
})

describe('the capture, read without being moved (KV-20)', () => {
  const CAPTURE_SECONDS = 30
  const emit: {
    progress?: (seconds: number) => void
    settling?: () => void
    guidance?: (line: string | null) => void
  } = {}

  beforeEach(() => {
    vi.useFakeTimers()
    const off = (): void => undefined
    Object.defineProperty(window, 'kinvue', {
      configurable: true,
      value: {
        onCaptureProgress: vi.fn((listener: (seconds: number) => void) => {
          emit.progress = listener
          return off
        }),
        onCaptureSettling: vi.fn((listener: () => void) => {
          emit.settling = listener
          return off
        }),
        onCaptureGuidance: vi.fn((listener: (line: string | null) => void) => {
          emit.guidance = listener
          return off
        }),
        onCaptureFrame: vi.fn(() => off),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const renderCapture = (failure: CaptureFailure | null = null) =>
    render(
      <CaptureScreen
        failure={failure}
        onCancel={() => undefined}
        captureSeconds={CAPTURE_SECONDS}
      />,
    )

  /** The countdown's live region: the one that is not on screen. */
  const countdownRegion = (): HTMLElement => {
    const region = document.querySelector<HTMLElement>('.sr-only[aria-live="polite"]')
    if (region === null) throw new Error('no countdown region')
    return region
  }

  it('puts focus on its heading as it opens', () => {
    renderCapture()
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Sit comfortably and look at the camera' }),
    )
  })

  it('says how long it takes once, after the heading, and not again each second', () => {
    renderCapture()
    // Empty while the heading is being read: a region filled as it is drawn
    // is one screen readers miss.
    expect(countdownRegion().textContent).toBe('')

    act(() => vi.advanceTimersByTime(COUNTDOWN_ANNOUNCE_DELAY_MS))
    expect(countdownRegion().textContent).toBe('This takes up to 30 seconds.')

    // The visible line counts down; what is announced does not change.
    act(() => emit.progress?.(7))
    expect(countdownRegion().textContent).toBe('This takes up to 30 seconds.')
    // And the visible count is not read beside it: two numbers that disagree
    // (review of #196). Hidden from the tree, so a query by role cannot find it.
    const shown = screen.getByText('Up to 23 seconds left')
    expect(shown.getAttribute('aria-hidden')).toBe('true')
    expect(
      screen.queryByText('Up to 23 seconds left', { ignore: '[aria-hidden="true"]' }),
    ).toBeNull()
  })

  it('says when it is finishing, whether main says so or the ceiling is reached', () => {
    renderCapture()
    act(() => emit.settling?.())
    expect(countdownRegion().textContent).toBe('Finishing up.')
    cleanup()

    renderCapture()
    act(() => emit.progress?.(CAPTURE_SECONDS))
    expect(countdownRegion().textContent).toBe('Finishing up.')
  })

  it('moves no one while it runs: advice and the count leave focus where it is', () => {
    renderCapture()
    const stop = screen.getByRole('button', { name: 'Stop' })
    stop.focus()

    act(() => {
      emit.guidance?.('Move a little closer.')
      emit.progress?.(5)
      vi.advanceTimersByTime(COUNTDOWN_ANNOUNCE_DELAY_MS)
      emit.settling?.()
    })
    expect(document.activeElement).toBe(stop)
  })

  it('announces advice as it changes, and not the reassurance between', () => {
    renderCapture()
    // One on screen, the advice's; the countdown's is the other, off screen.
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(2)
    const advice = (): string | null | undefined =>
      document.querySelector('[aria-live="polite"]:not(.sr-only)')?.textContent
    act(() => emit.guidance?.('Move a little closer.'))
    expect(advice()).toBe('Move a little closer.')
    act(() => emit.guidance?.(null))
    expect(advice()).toBe('')
    expect(screen.getByText('Holding still is all that is needed.')).toBeDefined()
  })

  it('moves focus to a failure as it replaces the capture, with its detail read next, once', () => {
    const { rerender } = renderCapture()
    screen.getByRole('button', { name: 'Stop' }).focus()

    rerender(
      <CaptureScreen
        failure="camera-unavailable"
        onCancel={() => undefined}
        captureSeconds={CAPTURE_SECONDS}
      />,
    )
    const heading = screen.getByRole('heading', { name: 'The camera could not be used' })
    expect(document.activeElement).toBe(heading)
    // Next in reading order, and not also the heading's description, which
    // read it twice one arrow apart (review of #196).
    expect(heading.nextElementSibling?.textContent).toMatch(/Another program may have it open/)
    expect(heading.hasAttribute('aria-describedby')).toBe(false)
  })

  it('draws every control and line at the path’s sizes, running and failed', () => {
    const running = renderCapture()
    expectPersonSized(running.container)
    cleanup()
    const failed = renderCapture('service-refused')
    expectPersonSized(failed.container)
  })
})
