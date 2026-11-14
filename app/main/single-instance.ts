/**
 * What the running Kinvue does when it is started again (KV-222).
 *
 * `boot.ts` holds Electron's single-instance lock, so a second start never
 * becomes a second main process on the same history; it leaves, and this copy
 * is told. Whoever pressed the shortcut wanted Kinvue in front of them, so the
 * window comes forward: restored if it was minimised, and focused. Nothing
 * else about the second start is honoured — not its arguments, not its working
 * directory.
 *
 * Its own module, free of Electron, so the rule is tested in the plain suite;
 * `index.ts` hands it the windows.
 */

/** The parts of a `BrowserWindow` this uses. */
export interface WindowLike {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  focus(): void
}

/**
 * Brings the first window still open forward. With none — on macOS the app
 * outlives its last window — `open` makes one, as clicking its dock icon does.
 *
 * A window not yet shown is left alone: `showWhenReady` is about to show it
 * (KV-139), and shown from here before its page has drawn, it would be the
 * blank window that waits to avoid. That is the usual case — a second press
 * while the first start is still opening.
 */
export function bringForward(windows: readonly WindowLike[], open: () => void): void {
  const window = windows.find((w) => !w.isDestroyed())
  if (window === undefined) {
    open()
    return
  }
  if (window.isMinimized()) window.restore()
  if (window.isVisible()) window.focus()
}
