import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SHOW_FALLBACK_MS,
  SHOW_GRACE_AFTER_LOAD_MS,
  showWhenReady,
  type Revealable,
} from '../app/main/window-show'

/**
 * The window reaches the screen by more than one road (KV-139). Before, it
 * was shown on `ready-to-show` alone, and a build that lost that event left
 * Kinvue running behind a window nobody could see.
 */

/** A window whose events the test fires by hand. */
function fakeWindow(): Revealable & {
  shows: number
  readyToShow(): void
  finishLoad(): void
  destroyed: boolean
  visible: boolean
} {
  let onReady: () => void = () => undefined
  let onLoad: () => void = () => undefined
  const w = {
    shows: 0,
    destroyed: false,
    visible: false,
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    show: () => {
      w.shows++
      w.visible = true
    },
    onReadyToShow: (listener: () => void) => {
      onReady = listener
    },
    onFinishLoad: (listener: () => void) => {
      onLoad = listener
    },
    readyToShow: () => onReady(),
    finishLoad: () => onLoad(),
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

  it('gives ready-to-show its chance first, so the normal path never shows an unpainted frame', () => {
    const w = fakeWindow()
    showWhenReady(w)
    w.finishLoad()
    vi.advanceTimersByTime(SHOW_GRACE_AFTER_LOAD_MS / 2)
    w.readyToShow()
    vi.advanceTimersByTime(SHOW_FALLBACK_MS)
    expect(w.shows).toBe(1)
  })

  it('shows it anyway when the page never loads at all', () => {
    const w = fakeWindow()
    showWhenReady(w)
    vi.advanceTimersByTime(SHOW_FALLBACK_MS - 1)
    expect(w.shows).toBe(0)
    vi.advanceTimersByTime(1)
    expect(w.shows).toBe(1)
  })

  it('shows it once, however many roads arrive', () => {
    const w = fakeWindow()
    showWhenReady(w)
    w.readyToShow()
    w.finishLoad()
    w.readyToShow()
    vi.advanceTimersByTime(SHOW_FALLBACK_MS * 2)
    expect(w.shows).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves alone a window closed before it was ever shown', () => {
    const w = fakeWindow()
    showWhenReady(w)
    w.destroyed = true
    vi.advanceTimersByTime(SHOW_FALLBACK_MS)
    expect(w.shows).toBe(0)
  })
})
