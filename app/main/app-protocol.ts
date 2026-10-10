import { isAbsolute, join, normalize, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The built page's own scheme (KV-19), in place of `file://` — Electron's
 * checklist item 18. `app://kinvue/` serves the built renderer's files and
 * nothing else: not the rest of the app, not the disk.
 *
 * Registered as privileged — standard and secure — before `ready`, in
 * `app/main/index.ts`. Without that, the page's origin is opaque, `'self'` in
 * its CSP matches nothing, and it cannot load its own bundle.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'kinvue'
export const APP_PAGE_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/**
 * The file under `root` that `requestUrl` names, or null for anything that is
 * not one of ours: another scheme or host, a path that climbs out of `root`
 * however it is spelled, or one that is not a URL at all. `/` is the page.
 *
 * Decided from the parsed URL's protocol, host and path, as the window's
 * checks are (`security.ts`): Node gives `app:` no origin (review of #192).
 */
export function appFileFor(requestUrl: string, root: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  // Refused here, before the climb check below reasons about it: the
  // operating system would cut the path short at a NUL byte, so the path that
  // check approves would not be the one opened (review of #193).
  if (path.includes('\0')) return null
  if (path === '/' || path === '') path = '/index.html'
  const file = normalize(join(root, path))
  const inside = relative(root, file)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
  return file
}

const notFound = (): Response => new Response('Not found', { status: 404 })

/**
 * The answer to an `app://` request: the file `appFileFor` names, read with
 * `fetchFile` (Electron's `net.fetch` in `app/main/index.ts`), or a 404.
 *
 * Anything that cannot be served is the same clean 404 as anything refused
 * (review of #193): a name inside the renderer that is a folder, a file that is
 * not there, a read that fails. Otherwise a folder's failed fetch reached the
 * page as a network error, and the main process's log as noise.
 */
export async function serveApp(
  requestUrl: string,
  root: string,
  fetchFile: (fileUrl: string) => Promise<Response>,
): Promise<Response> {
  const file = appFileFor(requestUrl, root)
  if (file === null) return notFound()
  try {
    const response = await fetchFile(pathToFileURL(file).href)
    return response.ok ? response : notFound()
  } catch {
    return notFound()
  }
}
