/**
 * The window's trust boundary: which page is Kinvue's own (KV-29).
 *
 * The window may be at one page only — the dev server in development, the
 * built `index.html` once packaged — and it is the only frame the main process
 * answers over IPC. Everything past that line, the camera, the API key and the
 * check-in history, is reached through those answers, so "is this our page"
 * is decided once, here, rather than in every handler.
 *
 * Imports nothing from Electron, so the decisions are tested in the plain
 * suite; `app/main/index.ts` adapts navigations and IPC events to them.
 */

/** Where Kinvue's own page lives. */
export type AppPage =
  /** Development: the electron-vite dev server, matched by origin. */
  | { kind: 'dev'; origin: string }
  /** Built: `index.html` on disk, matched by path. A `file:` origin is "null", and says nothing. */
  | { kind: 'file'; pathname: string }

/**
 * The page the window loads: the dev server when electron-vite names one, the
 * built `index.html` otherwise — the same choice `createWindow` makes.
 */
export function appPage(devUrl: string | undefined, indexHtmlFileUrl: string): AppPage {
  return devUrl !== undefined && devUrl !== ''
    ? { kind: 'dev', origin: new URL(devUrl).origin }
    : { kind: 'file', pathname: new URL(indexHtmlFileUrl).pathname }
}

/**
 * Whether `url` is Kinvue's own page: the one place the window may navigate
 * to, and the only frame IPC is answered for. A query or a fragment does not
 * make it another page; another origin, another file or another scheme does.
 * Anything that is not a URL is not ours.
 */
export function isAppUrl(url: string, page: AppPage): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return page.kind === 'dev'
    ? parsed.origin === page.origin
    : parsed.protocol === 'file:' && parsed.pathname === page.pathname
}

/** The frame an IPC message came from, as much as the check needs. */
export interface SenderFrame {
  url: string
  /** A subframe is never trusted, even one showing our own page. */
  isMainFrame: boolean
}

/**
 * Whether an IPC message may be answered: it came from the main frame of
 * Kinvue's own page. Null — a frame already gone, or navigated away before
 * the message was handled — is not trusted.
 */
export function isTrustedSender(frame: SenderFrame | null, page: AppPage): boolean {
  return frame !== null && frame.isMainFrame && isAppUrl(frame.url, page)
}
