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

/** Where Kinvue's own page lives, and the exact URL the window loads for it. */
export type AppPage =
  /** Development: the electron-vite dev server, matched by origin. */
  | { kind: 'dev'; origin: string; url: string }
  /** Built: `index.html` on disk, matched by path. A `file:` origin is "null", and says nothing. */
  | { kind: 'file'; pathname: string; url: string }

/** The page, and what was wrong with the dev server's address, if anything. */
export interface ResolvedPage {
  page: AppPage
  /** Said once the app is ready, as a `.env` that cannot be read is; null when all is well. */
  problem: string | null
}

const filePage = (fileUrl: string): AppPage => ({
  kind: 'file',
  pathname: new URL(fileUrl).pathname,
  url: new URL(fileUrl).href,
})

/**
 * The page the window loads: the dev server when electron-vite names one, the
 * built `index.html` otherwise. `createWindow` loads `page.url` itself, so the
 * URL the window is at and the URL these checks compare against are one string,
 * not two built different ways that must agree (review of #169).
 *
 * Only an `http(s)` dev server is matched by origin. Anything else has no
 * origin to match — a `file:`, `data:` or `about:` URL's origin is the string
 * "null" — and matching on it made every URL without an origin "our page",
 * `javascript:` included. A `file:` dev URL is a file page like the built one;
 * anything else, or a value that is not a URL at all (`localhost:5173` parses
 * as the scheme `localhost:`), falls back to the built page and is reported,
 * rather than inverting the boundary or throwing before there is a window to
 * say why (review of #169).
 */
export function resolveAppPage(devUrl: string | undefined, indexHtmlFileUrl: string): ResolvedPage {
  const built = filePage(indexHtmlFileUrl)
  if (devUrl === undefined || devUrl === '') return { page: built, problem: null }
  let parsed: URL
  try {
    parsed = new URL(devUrl)
  } catch {
    return {
      page: built,
      problem: `ELECTRON_RENDERER_URL is not a URL ("${devUrl}"), so the built page was loaded instead.`,
    }
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { page: { kind: 'dev', origin: parsed.origin, url: parsed.href }, problem: null }
  }
  if (parsed.protocol === 'file:' && parsed.host === '') return { page: filePage(parsed.href), problem: null }
  return {
    page: built,
    problem:
      `ELECTRON_RENDERER_URL must be an http(s) or local file URL, not "${devUrl}", ` +
      'so the built page was loaded instead.',
  }
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
  // A `file:` URL can name a host — `file://attacker.example/C:/…/index.html`
  // has our path on someone else's machine — so the host must be empty too
  // (review of #169). `file://localhost/…` normalises to an empty host, and is
  // ours.
  return page.kind === 'dev'
    ? parsed.origin === page.origin
    : parsed.protocol === 'file:' && parsed.host === '' && parsed.pathname === page.pathname
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
