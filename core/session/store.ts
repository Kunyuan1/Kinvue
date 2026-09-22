import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { failureTag } from '../capture/failure'
import type { SessionRecord } from './types'

/**
 * MAIN PROCESS ONLY — this module imports node:fs. The renderer reaches
 * sessions over IPC (see app/preload), never by importing this file.
 *
 * A JSON file, not SQLite, is a deliberate choice: a check-in is one
 * small record a day, so a single file is correct at this size and costs no
 * native rebuild against Electron's ABI. The interface below is the seam to
 * swap if that stops being true. See README "Known Limitations".
 */
export interface SessionStore {
  /** All sessions for a person, oldest first. */
  list(personId: string): Promise<SessionRecord[]>
  /** Append one session. Sessions are never edited in place. */
  append(record: SessionRecord): Promise<void>
  /** Every person with at least one session. */
  people(): Promise<string[]>
}

/**
 * The version this code writes and is willing to read.
 *
 * Read, not decoration (KV-13). It was written on every save and checked
 * nowhere, which implies a migration story that does not exist — and a file
 * from a later version would have been read as though it were this one, which
 * is the quiet kind of wrong. Sync (#30) will need a version on each record
 * rather than on the file; this is only about the file.
 */
const FILE_VERSION = 1

/**
 * The file as it is on disk once both checks have passed.
 *
 * `version` is `number`, not `typeof FILE_VERSION`. Typing it as the literal
 * made `isFileShape` claim something it had not checked — it only looks at
 * `sessions` — and the claim was load-bearing rather than untidy: after the
 * guard, `parsed.version` narrowed to `1`, so inside the version check it
 * narrowed to `never`. The check was provably unreachable to the compiler, and
 * `String(parsed.version)` was what let it compile at all. Anyone trusting
 * that narrowing could delete the check with no type error and no failing
 * test, on a field KV-13 exists to start reading (KV-13 review).
 */
interface FileShape {
  version: number
  sessions: SessionRecord[]
}

/**
 * A fresh empty file, built each time rather than spread from a constant.
 *
 * `{ ...EMPTY }` is a shallow copy, so every caller shared one `sessions`
 * array — and `append` pushes into whatever `read` returned. One append on a
 * first run therefore left a record in the module-level array that every later
 * "empty" read started from. Invisible in the app, where the file exists after
 * the first write and `read` returns the parsed object instead, and invisible
 * without a test, which is what KV-13 is about.
 */
const empty = (): FileShape => ({ version: FILE_VERSION, sessions: [] })

/**
 * A file exists and this code will not risk interpreting it.
 *
 * Distinct from "no file", which is the ordinary first run. Raised rather than
 * returning an empty history because `append` is read-modify-write: a read
 * that answered "empty" for a file it could not parse would push one record
 * onto nothing and rename that over the original. The history the comparisons
 * depend on would be gone, on the one path where the app already knew
 * something was wrong (KV-13).
 *
 * The message is written for the person who will see it, not for a log. It
 * does not yet reach them in that shape — `listSessions` is a bare
 * `ipcRenderer.invoke` passthrough and the renderer prints `String(e)`, so
 * Electron's wrapper prefix arrives with it. #95 owns that.
 *
 * **Tagged `store-unreadable`, and that matters most on the submit path.**
 * `submit` reads history before scoring, so this can be raised after the
 * capture ran and all four questions were answered. Untagged it classified
 * `unknown`, whose copy is "Trying again is worth a go" — written for a full
 * disk or a permission, both of which can clear. This one cannot: it will
 * fail identically every time until the file is moved aside, so inviting a
 * retry is the reassuring-and-wrong direction this class exists to remove.
 *
 * The tag rides in the message because that is the only thing that survives
 * IPC — see `core/capture/failure.ts`. It is never shown: #95 owns stripping
 * it, along with Electron's own wrapper, before any of this reaches a screen.
 */
export class UnreadableStoreError extends Error {
  constructor(path: string, why: string) {
    super(
      `${failureTag('store-unreadable')}: The check-in history at ${path} could not be read: ` +
        `${why}. Nothing has been changed. Move the file aside to start fresh.`,
    )
    this.name = 'UnreadableStoreError'
  }
}

/**
 * Only what it actually checks: an object with a `sessions` array. The version
 * is checked separately, before this, and the records themselves are still not
 * validated — `isFileShape` says nothing about what is *in* `sessions`. KV-74
 * had to defend against exactly that in the scorer; it belongs with #30's
 * record format rather than here.
 */
function isFileShape(value: unknown): value is FileShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { sessions?: unknown }).sessions)
  )
}

/**
 * Why a version was refused, in words that match what was actually found.
 *
 * Interpolating the value directly produced "it is version undefined" for a
 * file with no `version` key — a value nobody wrote — and "it is version
 * [object Object]" for a non-number. Both read as though the file declared
 * something odd, when the truth is that it declared nothing usable
 * (KV-13 review).
 */
function describeVersion(version: unknown): string {
  if (typeof version === 'number' && Number.isFinite(version)) {
    return `it is version ${String(version)} and this app writes version ${String(FILE_VERSION)}`
  }
  return `it does not say which version it is, and this app writes version ${String(FILE_VERSION)}`
}

async function read(path: string): Promise<FileShape> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    // A missing file is the normal first-run state, not an error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    throw err
  }

  // An empty file is the one corruption with nothing to protect.
  //
  // Refusing is right everywhere else *because* answering "empty" would let
  // `append` rename one record over real history. A zero-byte file holds no
  // history, so there is none to lose — and it is the likeliest real
  // corruption of the three: a power cut between `writeFile` and `rename`, an
  // antivirus quarantine-and-restore, a cloud-sync conflict resolving to
  // nothing. `JSON.parse('')` throws, so without this it was a permanent
  // refusal protecting nothing (KV-13 review).
  if (text.trim() === '') return empty()

  // From here a file exists with something in it, so "I do not understand
  // this" can no longer be answered with an empty history — see
  // `UnreadableStoreError`.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UnreadableStoreError(path, 'it is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new UnreadableStoreError(path, 'it is not a check-in history file')
  }

  // Version before shape, because a file from a later version is precisely the
  // one most likely to differ in shape. Checked the other way round, a version
  // 2 file that renamed `sessions` was refused with "it has no list of
  // sessions" — a claim about the person's data — instead of the version
  // mismatch, which names the real problem and implies the fix (KV-13 review).
  const version: unknown = (parsed as { version?: unknown }).version
  if (version !== FILE_VERSION) {
    throw new UnreadableStoreError(path, describeVersion(version))
  }
  if (!isFileShape(parsed)) {
    throw new UnreadableStoreError(path, 'it has no list of sessions')
  }
  return parsed
}

/**
 * Written via a temp file and a rename so a crash mid-write cannot truncate
 * the history. Losing a day's check-in is recoverable; losing the baseline the
 * comparisons depend on is not.
 */
async function write(path: string, data: FileShape): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, path)
}

export function createJsonSessionStore(path: string): SessionStore {
  return {
    async list(personId) {
      const { sessions } = await read(path)
      return sessions
        .filter((s) => s.personId === personId)
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    },
    /**
     * Read-modify-write, with no lock.
     *
     * Safe at one record per person per day, which is what this app produces,
     * and stated rather than left to be discovered: two appends genuinely at
     * once would have the later read miss the earlier write and drop it. The
     * single-window guard in `app/main` means there is one writer, so the
     * assumption holds today rather than by luck — it stops holding the moment
     * a second process writes here, which is #39's problem to inherit.
     */
    async append(record) {
      const data = await read(path)
      data.sessions.push(record)
      await write(path, data)
    },
    async people() {
      const { sessions } = await read(path)
      return [...new Set(sessions.map((s) => s.personId))]
    },
  }
}
