/**
 * Getting the window onto the screen, by more than one road (KV-139).
 *
 * The window is created hidden and shown on `ready-to-show`, so the person
 * never sees an unpainted frame. That was the *only* way it reached the
 * screen, and Electron 44.4.4 fixed "ready-to-show never firing for some hidden
 * windows on Windows and Linux". On a build where that event is lost, Kinvue
 * starts and serves IPC behind a window nobody can see — and because the window
 * exists, `window-all-closed` never fires, so there is no way out but Task
 * Manager. The fix upstream closes the known trigger, not the single road.
 *
 * So there are three, and the first to arrive wins:
 *
 * 1. `ready-to-show` — the normal path: shown the moment the page has painted.
 * 2. `did-finish-load`, **plus a short grace**. The page has loaded, so it will
 *    paint any moment; waiting a little gives `ready-to-show` its chance first,
 *    so the normal path never flashes an unpainted frame.
 * 3. An absolute fallback, for a page that never finishes loading at all — a
 *    dev server that is not running, say. Better a visible window with nothing
 *    in it than an invisible one.
 *
 * Imports nothing from Electron, so the decision is tested in the plain suite;
 * `app/main/index.ts` adapts the real window to `Revealable`.
 */

/** The parts of a window, and its page, that the decision needs. */
export interface Revealable {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  onReadyToShow(listener: () => void): void
  onFinishLoad(listener: () => void): void
}

/** How long after the page loads to wait for `ready-to-show` before showing anyway. */
export const SHOW_GRACE_AFTER_LOAD_MS = 1000

/** The longest a window may stay hidden from creation, whatever else happens. */
export const SHOW_FALLBACK_MS = 10_000

export function showWhenReady(window: Revealable): void {
  let settled = false
  const timers: ReturnType<typeof setTimeout>[] = []

  const reveal = (): void => {
    if (settled) return
    settled = true
    for (const timer of timers) clearTimeout(timer)
    // Closed before it was ever shown, or shown by something else: leave it.
    if (window.isDestroyed() || window.isVisible()) return
    window.show()
  }

  window.onReadyToShow(reveal)
  window.onFinishLoad(() => {
    if (!settled) timers.push(setTimeout(reveal, SHOW_GRACE_AFTER_LOAD_MS))
  })
  timers.push(setTimeout(reveal, SHOW_FALLBACK_MS))
}
