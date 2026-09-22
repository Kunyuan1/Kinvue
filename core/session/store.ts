import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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

interface FileShape {
  version: typeof FILE_VERSION
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
 */
export class UnreadableStoreError extends Error {
  constructor(path: string, why: string) {
    super(
      `The check-in history at ${path} could not be read: ${why}. ` +
        'Nothing has been changed. Move the file aside to start fresh.',
    )
    this.name = 'UnreadableStoreError'
  }
}

function isFileShape(value: unknown): value is FileShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as FileShape).sessions)
  )
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

  // From here a file exists, so "I do not understand this" can no longer be
  // answered with an empty history — see `UnreadableStoreError`.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UnreadableStoreError(path, 'it is not valid JSON')
  }
  if (!isFileShape(parsed)) {
    throw new UnreadableStoreError(path, 'it has no list of sessions')
  }
  if (parsed.version !== FILE_VERSION) {
    throw new UnreadableStoreError(
      path,
      `it is version ${String(parsed.version)} and this app writes version ${String(FILE_VERSION)}`,
    )
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
