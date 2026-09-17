/**
 * MAIN PROCESS ONLY. Loads a `.env` file into `process.env`.
 *
 * Node and Electron do not read `.env` files on their own, and electron-vite's
 * env handling is not a substitute: it only picks up variables prefixed
 * `VITE_` / `MAIN_VITE_` / `PRELOAD_VITE_` / `RENDERER_VITE_`, and it exposes
 * them through `import.meta.env` — which means replacing them into the bundle
 * at build time. The API key must never be written into a built file, so it
 * stays unprefixed and is read at runtime, here. (KV-51)
 *
 * **This file must not import Electron.** It is covered by the plain node test
 * suite, which has no Electron binary — CI skips the download. Anything that
 * needs `app` (which path to read, whether to read one at all) belongs to the
 * caller in `index.ts`, which is why the path is a required argument.
 */

/**
 * Reads `path` into `process.env`. Returns false when there was no file there.
 *
 * A missing file is the normal case — CI, and any packaged install, where
 * nobody edits a dotfile (KV-19) — so it is not an error. Anything else is:
 * an unreadable file, or a path that is not a file, throws rather than leaving
 * the caller to guess why the key never arrived.
 *
 * What this does **not** do is validate the contents. `process.loadEnvFile` is
 * lenient by design: a line it cannot parse is skipped silently, and an
 * unquoted `#` starts a comment, so `KEY=ab#cd` arrives as `ab`. A truncated
 * value is indistinguishable from a short one, so nothing here can catch it —
 * `.env.example` says to quote a value containing `#` for that reason.
 *
 * `process.loadEnvFile` also leaves variables that are already set alone, so a
 * key exported in the shell wins over a stale `.env` in the working directory.
 * A test pins that, because it is behaviour this relies on rather than provides.
 */
export function loadDotEnv(path: string): boolean {
  try {
    process.loadEnvFile(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
