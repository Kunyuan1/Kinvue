import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ERR_ABORTED,
  SHOW_FALLBACK_MS,
  SHOW_GRACE_AFTER_LOAD_MS,
  loadFailureMessage,
  showWhenReady,
  type Revealable,
} from '../app/main/window-show'

/**
 * The window reaches the screen by more than one road (KV-139). Before, it
 * was shown on `ready-to-show` alone, and a build that lost that event left
 * Kinvue running behind a window nobody could see.
 */

/**
 * A window whose events the test fires by hand.
 *
 * `showMakesVisible: false` keeps it invisible after `show()`, so the
 * show-once guard is tested on its own: otherwise `isVisible()` catches the
 * second show first and the two guards mask each other (review of #140).
 */
function fakeWindow({ showMakesVisible = true } = {}): Revealable & {
  shows: number
  readyToShow(): void
  finishLoad(): void
  failLoad(): void
  destroyed: boolean
  visible: boolean
} {
  let onReady: () => void = () => undefined
  let onLoad: () => void = () => undefined
  let onFail: () => void = () => undefined
  const w = {
    shows: 0,
    destroyed: false,
    visible: false,
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    show: () => {
      w.shows++
      if (showMakesVisible) w.visible = true
    },
    onReadyToShow: (listener: () => void) => {
      onReady = listener
    },
    onFinishLoad: (listener: () => void) => {
      onLoad = listener
    },
    onFailLoad: (listener: () => void) => {
      onFail = listener
    },
    readyToShow: () => onReady(),
    finishLoad: () => onLoad(),
    failLoad: () => onFail(),
  }
  return w
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('showWhenReady (KV-139)', () => {
  it('shows the window the moment it has painted, the normal path', () => {
    const w = fakeWindow()
    showWhenReady(w)
    w.readyToShow()
    expect(w.shows).toBe(1)
  })

  it('shows it shortly after the page loads when ready-to-show never comes', () => {
    // The Electron bug 44.4.4 fixed, and the one this guards against next time.
    const w = fakeWindow()
    showWhenReady(w)
    w.finishLoad()
    vi.advanceTimersByTime(SHOW_GRACE_AFTER_LOAD_MS - 1)
    expect(w.shows).toBe(0)
    vi.advanceTimersByTime(1)
    expect(w.shows).toBe(1)
  })

  it('holds the load road for the grace, so ready-to-show can win it', () => {
    const w = fakeWindow()
    showWhenReady(w)
    w.finishLoad()
    vi.advanceTimersByTime(SHOW_GRACE_AFTER_LOAD_MS / 2)
    // The grace is still holding: the load alone has not shown it (review of #140).
    expect(w.shows).toBe(0)
    w.readyToShow()
    vi.advanceTimersByTime(SHOW_FALLBACK_MS)
    expect(w.shows).toBe(1)
  })

  it('shows it at once when the page fails to load, not after the fallback', () => {
    // A dev server that is not running: Electron says so in milliseconds, and
    // neither ready-to-show nor did-finish-load will ever come (review of #140).
    const w = fakeWindow()
    showWhenReady(w)
    w.failLoad()
    expect(w.shows).toBe(1)
  })

  it('shows it anyway when the page never reports anything at all', () => {
    const w = fakeWindow()
    showWhenReady(w)
    vi.advanceTimersByTime(SHOW_FALLBACK_MS - 1)
    expect(w.shows).toBe(0)
    vi.advanceTimersByTime(1)
    expect(w.shows).toBe(1)
  })

  it('leaves nothing pending once shown', () => {
    // Checked before time advances: after flushing, zero timers is true
    // whatever the code does (review of #140).
    const w = fakeWindow()
    showWhenReady(w)
    w.finishLoad()
    w.readyToShow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows it once, however many roads arrive', () => {
    // Invisible after show, so this is the show-once guard alone, not
    // `isVisible()` doing its job for it.
    const w = fakeWindow({ showMakesVisible: false })
    showWhenReady(w)
    w.readyToShow()
    w.finishLoad()
    w.failLoad()
    w.readyToShow()
    vi.advanceTimersByTime(SHOW_FALLBACK_MS * 2)
    expect(w.shows).toBe(1)
  })

  it('leaves alone a window something else has already shown', () => {
    const w = fakeWindow()
    showWhenReady(w)
    w.visible = true
    vi.advanceTimersByTime(SHOW_FALLBACK_MS)
    expect(w.shows).toBe(0)
  })

  it('leaves alone a window closed before it was ever shown', () => {
    const w = fakeWindow()
    showWhenReady(w)
    w.destroyed = true
    vi.advanceTimersByTime(SHOW_FALLBACK_MS)
    expect(w.shows).toBe(0)
  })
})

describe('loadFailureMessage (KV-139 review)', () => {
  /** What Electron's loadURL rejects with: an Error carrying code and errno. */
  const loadError = (code: string, errno: number): Error =>
    Object.assign(new Error(`${code} (${errno}) loading 'http://localhost:5173/'`), {
      code,
      errno,
    })

  it('explains an empty window to whoever is in front of it, with the error last', () => {
    const message = loadFailureMessage(loadError('ERR_CONNECTION_REFUSED', -102))
    expect(message).toMatch(/^Kinvue could not load its screen/)
    expect(message).toMatch(/No check-in has been affected/)
    expect(message).toMatch(/ERR_CONNECTION_REFUSED/)
  })

  it('says nothing about a navigation that was only replaced', () => {
    expect(loadFailureMessage(loadError('ERR_ABORTED', ERR_ABORTED))).toBeNull()
    expect(loadFailureMessage(Object.assign(new Error('x'), { errno: ERR_ABORTED }))).toBeNull()
  })

  it('still explains a failure that carries no code at all', () => {
    expect(loadFailureMessage(new Error('file not found'))).toMatch(/file not found$/)
  })
})
