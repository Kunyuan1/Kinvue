// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  classifyCaptureError,
  type CaptureFailure,
  type SubmitFailure,
} from '@core/capture/failure'
import CaptureScreen from '@renderer/components/CaptureScreen'
import QuestionFlow from '@renderer/components/QuestionFlow'

/**
 * That the failure copy reaches the screen.
 *
 * The rest of the suite proves a throw is classified correctly; it stops at
 * the point where a `CaptureFailure` becomes something a person reads. These
 * were the five checks KV-7 could only list as manual, and four of them were
 * really one question — does the copy table render? — which does not need a
 * camera to answer.
 *
 * What is still manual, and stays that way: a camera genuinely held by another
 * program, and a capture that genuinely measured nothing. Those are facts
 * about hardware, and no DOM can assert them (KV-7).
 *
 * Asserted by *meaning*, never by matching the sentence: the wording is meant
 * to be rewritten, and a test that pins it would make that a chore. What must
 * not change is which failure gets which message.
 */

/** The preload bridge. `CaptureScreen` subscribes before it renders anything. */
beforeEach(() => {
  const off = (): void => undefined
  Object.defineProperty(window, 'kinvue', {
    configurable: true,
    value: {
      onCaptureProgress: vi.fn(() => off),
      onCaptureSettling: vi.fn(() => off),
      onCaptureGuidance: vi.fn(() => off),
      onCaptureFrame: vi.fn(() => off),
    },
  })
  // jsdom has no object URLs, and the frame preview makes them.
  window.URL.createObjectURL = vi.fn(() => 'blob:stub')
  window.URL.revokeObjectURL = vi.fn()
})

afterEach(cleanup)

const noop = (): void => undefined

/** The capture length is main's to decide (#63); these tests are about copy. */
const CAPTURE_SECONDS = 30
const renderCapture = (failure: CaptureFailure | null): void => {
  render(<CaptureScreen failure={failure} onCancel={noop} captureSeconds={CAPTURE_SECONDS} />)
}

describe('CaptureScreen says which failure it was', () => {
  // Only what the capture path can raise. The submit-path entries this table
  // used to carry were copy no press could reach (KV-75).
  const cases: [CaptureFailure, RegExp][] = [
    // Check 1: rename .env. Not a registration URL and a dotfile instruction.
    ['no-api-key', /not set up yet/i],
    // Check 2: the camera held by something else.
    ['camera-unavailable', /camera could not be used/i],
    // Check 3: Take a reading pressed twice.
    ['capture-in-progress', /camera is still busy/i],
    ['unknown', /could not be taken/i],
  ]

  it.each(cases)('renders %s as its own sentence', (failure, expected) => {
    renderCapture(failure)
    expect(screen.getByText(expected)).toBeDefined()
  })

  it('does not ask the person to wait for a reading that is being discarded', () => {
    // The only control here is Go back, which stops the running capture. The
    // copy used to say "try again in a few seconds" beside it: a wait that
    // gains nothing, since the reading is dropped when it lands and this
    // screen offers no way to retry (KV-76).
    renderCapture('capture-in-progress')
    const text = document.body.textContent ?? ''

    // The negative half carries the KV-76 decision: no wait is asked for.
    // The positive half says only that the copy names what the button does —
    // pinning the sentence around it would make a reword a chore, which the
    // note at the top of this file asks tests here not to do.
    expect(text).not.toMatch(/try again|wait a few|in a few seconds/i)
    expect(text).toMatch(/stop/i)
  })

  it('names no condition and shows no raw error string', () => {
    for (const [failure] of cases) {
      cleanup()
      renderCapture(failure)
      const text = document.body.textContent ?? ''
      // The whole point of the tag is that it never reaches a person.
      expect(text).not.toMatch(/kinvue\//)
      expect(text).not.toMatch(/\bError\b|stack|undefined|\[object/i)
    }
  })

  it('does not blame the person for a setup or hardware fault', () => {
    // The framing is the product: these three are not about them, and the
    // screen is the one addressed to the cared-for person.
    for (const failure of ['no-api-key', 'camera-unavailable'] as const) {
      cleanup()
      renderCapture(failure)
      expect(document.body.textContent).toMatch(/nothing is wrong on your side/i)
    }
  })

  it('classifies a capture the person stopped themselves as nothing to say', () => {
    // The flat union carried a "Stopped — the camera is off" card that nothing
    // could ever render (KV-75). This is the half of that worth pinning: the
    // classifier answers null, which is the no-failure state.
    const failure = classifyCaptureError(new Error('kinvue/cancelled: the reading was stopped.'))
    expect(failure).toBeNull()
  })

  it('renders the live capture, not an error, when there is no failure to show', () => {
    // What `failure={null}` actually produces — asserted rather than assumed.
    // An earlier version of this test looked for the deleted "stopped" copy,
    // which no longer exists in `FAILURE` and so could not have appeared
    // whatever the component did; it passed by describing absent strings.
    //
    // This is also why `App` must not mount this screen on a cancellation: null
    // means the capture ended, but the component reads it as "nothing has gone
    // wrong yet" and shows a countdown and a Stop button for a capture that is
    // over. `App`'s catch calls `setCapturing(false)` on null for that reason.
    renderCapture(null)
    // The live state is asserted through its control rather than its prose:
    // the guidance wording is meant to be rewritten freely, per the note at the
    // top of this file, and a Stop button offered for a capture that is over is
    // the part that would actually mislead.
    expect(screen.getByRole('button', { name: /stop/i })).toBeDefined()
    expect(document.body.textContent).not.toMatch(/could not|went wrong|not set up/i)
  })

  it.each([30, 45, 60])('counts down from the %ss main is actually running', (seconds) => {
    // The countdown used to be its own constant, so changing the capture
    // length in main left the screen promising the old one (#63). Several
    // lengths rather than one negative assertion: nothing else renders a
    // seconds string here, so `not.toMatch(/30 seconds/)` could not have
    // failed whether or not the constant came back.
    render(<CaptureScreen failure={null} onCancel={noop} captureSeconds={seconds} />)
    expect(document.body.textContent).toMatch(new RegExp(`${String(seconds)} seconds`, 'i'))
    // A ceiling, not a promise: the capture ends when every metric has
    // arrived, which is usually sooner (#63).
    expect(document.body.textContent).toMatch(/up to/i)
    expect(document.body.textContent).not.toMatch(/about \d+ seconds/i)
  })

  it('stops promising seconds once main says the capture is finishing', () => {
    // The countdown is derived from the ceiling, so a capture that collected
    // everything at 40s of a 90s ceiling read "Up to 50 seconds left" and then
    // vanished — wrong by most of a minute on exactly the runs the early stop
    // is for, and leaving "Finishing up" reachable only when something never
    // arrived (#63).
    let announceSettling = (): void => undefined
    const off = (): void => undefined
    Object.defineProperty(window, 'kinvue', {
      configurable: true,
      value: {
        onCaptureProgress: vi.fn(() => off),
        onCaptureSettling: vi.fn((fn: () => void) => {
          announceSettling = fn
          return off
        }),
        onCaptureGuidance: vi.fn(() => off),
        onCaptureFrame: vi.fn(() => off),
      },
    })

    render(<CaptureScreen failure={null} onCancel={noop} captureSeconds={90} />)
    expect(document.body.textContent).toMatch(/up to 90 seconds/i)

    act(() => {
      announceSettling()
    })
    expect(document.body.textContent).toMatch(/finishing up/i)
    expect(document.body.textContent).not.toMatch(/seconds left/i)
  })

  it('shows nothing at all when there is no failure', () => {
    renderCapture(null)
    expect(screen.queryByText(/not set up yet/i)).toBeNull()
  })
})

describe('QuestionFlow says which failure it was', () => {
  const show = (failure: SubmitFailure): string => {
    render(<QuestionFlow failure={failure} onDone={noop} onCancel={noop} submitting={false} />)
    return document.body.textContent ?? ''
  }

  // Check 4: the questions left for fifteen minutes.
  it('tells the person a reading expired rather than that saving broke', () => {
    expect(show('expired')).toMatch(/too long passed/i)
  })

  it('tells the person a reading is gone', () => {
    expect(show('no-capture')).toMatch(/no longer available/i)
  })

  it('does not send the person to the camera when the reading is still theirs', () => {
    // `createCheckIn` refiles the held reading on every untagged write failure,
    // so the capture and the four answers are both still submittable. Advice
    // to take a new reading would spend them to fail in the same way.
    const text = show('unknown')
    expect(text).toMatch(/trying again/i)
    expect(text).not.toMatch(/new reading|take a new|fresh one/i)
  })

  it('leaks no tag into what the person reads', () => {
    for (const failure of ['expired', 'no-capture', 'unknown'] as const) {
      cleanup()
      expect(show(failure)).not.toMatch(/kinvue\//)
    }
  })
})

describe('end to end, from the thrown error to the sentence', () => {
  it('turns what main throws into the right screen, over IPC', () => {
    // What Electron actually hands the renderer: the message, wrapped twice.
    const overIpc = new Error(
      "Error invoking remote method 'checkin:capture': Error: kinvue/no-api-key: " +
        'SMARTSPECTRA_API_KEY is not set.',
    )
    const failure = classifyCaptureError(overIpc)
    expect(failure).toBe('no-api-key')
    renderCapture(failure)

    expect(screen.getByText(/not set up yet/i)).toBeDefined()
    // The old behaviour: this exact string in front of the cared-for person.
    expect(document.body.textContent).not.toMatch(/SMARTSPECTRA_API_KEY/)
  })
})
