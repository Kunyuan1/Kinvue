import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StoreCipher } from '@core/session/store'
import type { KeyStatus } from '../shared/api-key'

export type { KeyStatus }

/**
 * The household's own SmartSpectra key (KV-19, T15): asked for on first run,
 * kept in its own file under `userData`, encrypted with the operating system's
 * key as the history is (KV-175). Never in `sessions.json`, never in the
 * installer, and never sent to the page: the page learns only a `KeyStatus`.
 *
 * What #192's review decided, and where it is held here:
 * - **Never sealed before the operating system's key is on disk.** A key
 *   typed in the seconds before Chromium writes `Local State` and sealed then
 *   would be lost to a crash. A credential cannot be left plain on disk the
 *   way a history can in that gap, so it is held in memory (`held`) — usable
 *   by a capture — and sealed by `settle()` once the key has landed. Closed in
 *   between, it is asked for again.
 * - **A key file that will not open is one of two things.** A key store not
 *   reachable now (`locked`) keeps the file and is asked again at the next
 *   start; nothing replaces it meanwhile, so a good key is never thrown away
 *   for a locked store. One that answered and still would not open it (`lost`)
 *   is asked for again, and the new key replaces the file.
 * - **Where there is no key store**, it is kept unencrypted (`saved-plain`),
 *   and the screen says so.
 *
 * Takes the cipher rather than building it, so the rules are tested in plain
 * node with a stand-in, as the store's are.
 */

/** The cipher, and whether the operating system holds a real key at all. */
export type KeyCipher = StoreCipher & { readonly holdsKey: boolean }

const FILE_VERSION = 1

/** The shortest and longest a key may be: a paste of a paragraph is not a key. */
const MIN_LENGTH = 8
const MAX_LENGTH = 512

/**
 * The key in `typed`, as it is kept and used, or null when it cannot be one:
 * trimmed, then at least 8 and at most 512 printable characters with no space
 * in them. Not a check against Presage — only a capture asks it — but a pasted
 * line with a label or a line break in it is refused here, where it can be
 * fixed, rather than at a capture, where it reads as a refused key.
 */
export function checkKey(typed: string): string | null {
  const key = typed.trim()
  if (key.length < MIN_LENGTH || key.length > MAX_LENGTH) return null
  return /^[\x21-\x7e]+$/.test(key) ? key : null
}

export interface ApiKeyStore {
  /** Reads the file once, at start. Never throws: what it found is the status. */
  load(): Promise<void>
  status(): KeyStatus
  /** The key a capture uses: from memory or the opened file. Null with none. */
  current(): string | null
  /**
   * Keeps `typed` as the key, sealed now if it can be, held in memory if the
   * operating system's key is not yet on disk. Refused — throws — for a key
   * that cannot be one, and while the key store is out of reach: a locked
   * store's file is a good key not to be replaced unseen.
   */
  set(typed: string): Promise<KeyStatus>
  /**
   * Seals a key held in memory, or kept plain, once the cipher can: called
   * by main's own seal loop. Resolves true when nothing is left to seal.
   */
  settle(): Promise<boolean>
}

interface KeyFile {
  version: number
  sealed?: unknown
  plain?: unknown
}

export function createApiKeyStore(path: string, cipher: KeyCipher): ApiKeyStore {
  let status: KeyStatus = 'none'
  let key: string | null = null
  // Whether the file on disk is sealed: the ratchet the history's store has
  // (review of #187). Once sealed, every write is sealed.
  let sealedOnDisk = false
  // `set` from the screen and `settle` from the seal loop can arrive together,
  // and both write through one temporary file: one at a time, as the history's
  // writes are (KV-175), so neither renames the other's half-written file.
  let tail: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }

  const write = async (contents: KeyFile): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(contents), 'utf8')
    await rename(tmp, path)
  }

  const seal = async (value: string): Promise<void> => {
    await write({ version: FILE_VERSION, sealed: cipher.seal(value) })
    sealedOnDisk = true
    status = 'saved'
  }

  return {
    async load() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (err) {
        // Missing is "none". Unreadable for any other reason is out of reach
        // now, not gone: kept, and asked again next start.
        status = (err as { code?: unknown }).code === 'ENOENT' ? 'none' : 'locked'
        return
      }
      let file: KeyFile
      try {
        file = JSON.parse(text) as KeyFile
      } catch {
        status = 'lost'
        return
      }
      if (file.version !== FILE_VERSION) {
        status = 'lost'
        return
      }
      if (typeof file.sealed === 'string') {
        sealedOnDisk = true
        if (!cipher.available()) {
          status = 'locked'
          return
        }
        try {
          const opened = checkKey(cipher.open(file.sealed))
          if (opened === null) throw new Error('not a key')
          key = opened
          status = 'saved'
        } catch {
          status = 'lost'
        }
        return
      }
      const plain = typeof file.plain === 'string' ? checkKey(file.plain) : null
      if (plain === null) {
        status = 'lost'
        return
      }
      key = plain
      status = 'saved-plain'
    },

    status: () => status,
    current: () => key,

    set(typed) {
      return exclusive(async () => {
        const checked = checkKey(typed)
        if (checked === null) throw new Error('That is not a SmartSpectra key.')
        if (status === 'locked') {
          throw new Error('The key store is not available, so the saved key is left as it is.')
        }
        key = checked
        if (cipher.encrypts || (sealedOnDisk && cipher.holdsKey)) {
          await seal(checked)
        } else if (!cipher.holdsKey) {
          await write({ version: FILE_VERSION, plain: checked })
          status = 'saved-plain'
        } else {
          // The operating system's key is not on disk yet: kept in memory only.
          status = 'held'
        }
        return status
      })
    },

    settle() {
      return exclusive(async () => {
        if ((status === 'held' || status === 'saved-plain') && key !== null && cipher.encrypts) {
          await seal(key)
        }
        return status !== 'held'
      })
    },
  }
}
