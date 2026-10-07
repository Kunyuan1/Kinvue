import { readFile } from 'node:fs/promises'
import type { AtRest, StoreCipher } from '@core/session/store'
import type { Protection } from '../shared/protection'

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
 * Read fresh each time it is asked, until the cipher has seen it there once;
 * asynchronously, so the wait for it never blocks the process that drives a
 * capture (review of #187).
 */
export const localStateHoldsKey =
  (path: string) =>
  async (): Promise<boolean> => {
    try {
      const state = JSON.parse(await readFile(path, 'utf8')) as {
        os_crypt?: { encrypted_key?: unknown }
      }
      const key = state.os_crypt?.encrypted_key
      return typeof key === 'string' && key !== ''
    } catch {
      return false
    }
  }

/** The store's cipher on this device, as `osCipher` makes it. */
export interface OsCipher extends StoreCipher {
  /** Whether the operating system holds a real key here: decided once, at start. */
  readonly holdsKey: boolean
  /**
   * Whether the key is on disk, asking `keyOnDisk` until it is and remembering
   * once it has been. Asked by main's own timer, never by a query the renderer
   * makes (review of #187): `encrypts` only reads what this found.
   */
  keyLanded(): Promise<boolean>
}

/**
 * The store's cipher on this device.
 *
 * **It seals nothing with a key that is not yet on disk** (KV-175). On Windows,
 * `safeStorage`'s key is wrapped by DPAPI and kept in the app's own `Local
 * State` file, which Chromium writes some seconds after the key is made —
 * measured: absent five seconds after start, there by fifteen. A history sealed
 * in that gap, then a crash or a forced quit, and the next start makes a new key
 * that opens nothing: the whole history lost, on the same account. So
 * `encrypts` is true only once `keyLanded()` has found the key on disk, and
 * until then writes stay plain; the seal lands once the key has. On macOS and
 * Linux the Keychain or the keyring keeps the key itself, and `keyOnDisk`
 * answers true at once.
 *
 * Whether the OS holds a real key is decided once, at start; `available()` is
 * asked each time a history is opened, so a key store locked since start reads
 * as locked, not as foreign.
 */
export function osCipher(
  storage: SafeStorageLike,
  platform: NodeJS.Platform,
  keyOnDisk: () => Promise<boolean>,
): OsCipher {
  const holds = holdsAKey(storage, platform)
  let landed = false
  return {
    holdsKey: holds,
    get encrypts() {
      return holds && landed
    },
    async keyLanded() {
      // Once on disk, it stays there: asked until then, not after.
      if (holds && !landed) landed = await keyOnDisk()
      return holds && landed
    },
    available: () => holdsAKey(storage, platform),
    // A dismissed Keychain prompt can fail like a key that is not ours.
    lockedLooksLikeForeign: platform === 'darwin',
    seal: (text) => storage.encryptString(text).toString('base64'),
    open: (sealed) => storage.decryptString(Buffer.from(sealed, 'base64')),
  }
}

/**
 * What the dashboard says about the history's protection: worked out from the
 * file on disk, not from the key (review of #187). The key can be ready while
 * the file is still plain — the seal not yet landed, or failed and being tried
 * again — and "encrypted" is said only of a file that is.
 *
 * A sealed file is encrypted whatever the key store says now. One that holds
 * nothing yet counts once the next write would be sealed: there is nothing
 * plain to describe.
 */
export function protectionOf(holdsKey: boolean, encrypts: boolean, onDisk: AtRest): Protection {
  if (onDisk === 'sealed') return 'encrypted'
  if (!holdsKey) return 'no-key-store'
  return onDisk === 'nothing' && encrypts ? 'encrypted' : 'not-yet-encrypted'
}
