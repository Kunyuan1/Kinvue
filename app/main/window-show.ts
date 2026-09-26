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
 * So there are four, and the first to arrive wins:
 *
 * 1. `ready-to-show` — the normal path: shown the moment the page has painted.
 *    This is the road that never shows an unpainted frame.
 * 2. `did-finish-load`, **plus a short grace**. The page has loaded and should
 *    paint any moment; waiting gives `ready-to-show` its chance first. A bet
 *    that React mounts within the grace, not a guarantee — the window's dark
 *    `backgroundColor` covers a miss.
 * 3. `did-fail-load` on the main frame — the page could not load at all, say
 *    a dev server that is not running. Electron says so within milliseconds,
 *    so there is nothing to wait for; `index.ts` also explains the empty
 *    window in a dialog (`loadFailureMessage`).
 * 4. An absolute fallback, for what Electron cannot report: a page that loads
 *    and never paints, a renderer lost at startup. Better a visible window
 *    than an invisible one.
 *
 * Imports nothing from Electron, so the decisions are tested in the plain
 * suite; `app/main/index.ts` adapts the real window to `Revealable`.
 */

/** The parts of a window, and its page, that the decision needs. */
export interface Revealable {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  onReadyToShow(listener: () => void): void
  onFinishLoad(listener: () => void): void
  /** A load of the main frame that failed — not a navigation merely replaced. */
  onFailLoad(listener: () => void): void
}

/** How long after the page loads to wait for `ready-to-show` before showing anyway. */
export const SHOW_GRACE_AFTER_LOAD_MS = 1_000

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
  window.onFailLoad(reveal)
  timers.push(setTimeout(reveal, SHOW_FALLBACK_MS))
}

/**
 * Chromium's code for a navigation that was replaced by another, not one that
 * failed. `loadURL` rejects with it, and `did-fail-load` reports it, whenever a
 * load is superseded — so it is never a reason to tell anyone anything.
 */
export const ERR_ABORTED = -3

/**
 * What to tell the person when the window's page could not be loaded, or null
 * when there is nothing to tell (KV-139 review).
 *
 * The window is shown either way, now; without this it is a dark, empty
 * rectangle with no message and no log anyone will read — closeable, but
 * nothing to tell whoever looks after the machine. So the load's rejection is
 * turned into a dialog, the way a `.env` that cannot be read already is.
 * Written for whoever is in front of it, not for a developer: what happened,
 * that no check-in is affected, and who can act. The error itself goes last,
 * for whoever that is.
 */
export function loadFailureMessage(err: unknown): string | null {
  const code = (err as { code?: unknown; errno?: unknown } | null)?.code
  const errno = (err as { errno?: unknown } | null)?.errno
  if (code === 'ERR_ABORTED' || errno === ERR_ABORTED) return null
  return (
    'Kinvue could not load its screen, so the window will stay empty. No check-in ' +
    'has been affected. Closing and reopening Kinvue may help; if it does not, ' +
    `whoever set it up can look into it.\n\n${String(err)}`
  )
}
