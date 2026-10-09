import { isAbsolute, join, normalize, relative } from 'node:path'

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
  // A NUL byte ends a path at the operating system, after the check below.
  if (path.includes('\0')) return null
  if (path === '/' || path === '') path = '/index.html'
  const file = normalize(join(root, path))
  const inside = relative(root, file)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
  return file
}
