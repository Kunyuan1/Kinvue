/**
 * MAIN PROCESS ONLY. Loads `.env` into `process.env` before anything reads it.
 *
 * Node and Electron do not read `.env` files on their own, and electron-vite's
 * env handling is not a substitute: it only picks up variables prefixed
 * `VITE_` / `MAIN_VITE_` / `PRELOAD_VITE_` / `RENDERER_VITE_`, and it exposes
 * them through `import.meta.env` — which means replacing them into the bundle
 * at build time. The API key must never be written into a built file, so it
 * stays unprefixed and is read at runtime, here. (KV-51)
 */

/**
 * Reads `path` into `process.env`.
 *
 * A missing file is the normal case — CI, and any packaged install, where
 * nobody edits a dotfile (KV-19) — so it is not an error. Anything else is:
 * an unreadable or malformed `.env` means the key is probably not what the
 * person thinks it is, and capture failing later with `MissingApiKeyError`
 * would point at the wrong thing.
 *
 * `process.loadEnvFile` leaves variables that are already set alone, so a key
 * exported in the shell wins over a stale `.env` in the working directory. A
 * test pins that, because it is behaviour this relies on rather than provides.
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}
