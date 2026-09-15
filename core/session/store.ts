import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionRecord } from './types'

/**
 * MAIN PROCESS ONLY — this module imports node:fs. The renderer reaches
 * sessions over IPC (see app/preload), never by importing this file.
 *
 * A JSON file, not SQLite, is a deliberate hackathon choice: a check-in is one
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

interface FileShape {
  version: 1
  sessions: SessionRecord[]
}

const EMPTY: FileShape = { version: 1, sessions: [] }

async function read(path: string): Promise<FileShape> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as FileShape).sessions)
    ) {
      return parsed as FileShape
    }
    return { ...EMPTY }
  } catch (err) {
    // A missing file is the normal first-run state, not an error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY }
    throw err
  }
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
