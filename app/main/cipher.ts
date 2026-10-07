import { readFileSync } from 'node:fs'
import type { StoreCipher } from '@core/session/store'

/**
 * The history's cipher, from Electron's `safeStorage` (KV-175): the key is the
 * operating system's — DPAPI on Windows, the Keychain on macOS, a desktop
 * keyring on Linux — and nothing for the person to remember.
 *
 * Takes the parts of `safeStorage` it uses rather than importing Electron, so
 * the rules below are tested in plain node.
 */

/** The parts of Electron's `safeStorage` this reads. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  /** Linux only; `unknown` before the app's `ready` event. */
  getSelectedStorageBackend(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * Whether `safeStorage` holds a real key here, asked after `ready`.
 *
 * **Not `isEncryptionAvailable()` alone** (review of #186): on Linux with no
 * keyring it falls back to `basic_text`, a fixed key — obfuscation, not
 * encryption — and still answers true. So on Linux the backend decides, and
 * only a real keyring counts; `unknown`, asked before `ready`, is not one. On
 * Windows and macOS, `isEncryptionAvailable()` is the check.
 */
export function holdsAKey(storage: SafeStorageLike, platform: NodeJS.Platform): boolean {
  if (!storage.isEncryptionAvailable()) return false
  if (platform !== 'linux') return true
  const backend = storage.getSelectedStorageBackend()
  return backend !== 'basic_text' && backend !== 'unknown'
}

/**
 * Whether Chromium has written `safeStorage`'s key to the `Local State` file at
 * `path` — on Windows, where it lives, DPAPI-wrapped, as `os_crypt.encrypted_key`.
 * Read fresh each time it is asked, until the cipher has seen it there once.
 */
export const localStateHoldsKey =
  (path: string) =>
  (): boolean => {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as {
        os_crypt?: { encrypted_key?: unknown }
      }
      const key = state.os_crypt?.encrypted_key
      return typeof key === 'string' && key !== ''
    } catch {
      return false
    }
  }

/** Where the history's protection stands, for the line that says so. */
export type Protection = 'encrypted' | 'waiting-for-key' | 'no-key-store'

/**
 * The store's cipher on this device, and where its protection stands.
 *
 * **It seals nothing with a key that is not yet on disk** (KV-175). On Windows,
 * `safeStorage`'s key is wrapped by DPAPI and kept in the app's own `Local
 * State` file, which Chromium writes some seconds after the key is made —
 * measured: absent five seconds after start, there by fifteen. A history sealed
 * in that gap, then a crash or a forced quit, and the next start makes a new key
 * that opens nothing: the whole history lost, on the same account. So
 * `encrypts` is true only once `keyOnDisk()` is, and until then writes stay
 * plain; the seal lands once the key has. On macOS and Linux the Keychain or the
 * keyring keeps the key itself, and `keyOnDisk` answers true at once.
 *
 * Whether the OS holds a real key is decided once, at start; `available()` is
 * asked each time a history is opened, so a key store locked since start reads
 * as locked, not as foreign.
 */
export function osCipher(
  storage: SafeStorageLike,
  platform: NodeJS.Platform,
  keyOnDisk: () => boolean,
): StoreCipher & { protection(): Protection } {
  const holds = holdsAKey(storage, platform)
  let landed = false
  const sealable = (): boolean => {
    // Once on disk, it stays there: asked until then, not after.
    if (holds && !landed) landed = keyOnDisk()
    return holds && landed
  }
  return {
    get encrypts() {
      return sealable()
    },
    protection: () => (!holds ? 'no-key-store' : sealable() ? 'encrypted' : 'waiting-for-key'),
    available: () => holdsAKey(storage, platform),
    // A dismissed Keychain prompt can fail like a key that is not ours.
    lockedLooksLikeForeign: platform === 'darwin',
    seal: (text) => storage.encryptString(text).toString('base64'),
    open: (sealed) => storage.decryptString(Buffer.from(sealed, 'base64')),
  }
}
