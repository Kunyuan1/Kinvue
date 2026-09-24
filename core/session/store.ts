import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
  /**
   * Sets an unreadable history aside so a new, empty one can begin (KV-98).
   * Returns where the old file now is, or null when there was nothing to set
   * aside — see the implementation for why a readable file is never moved.
   */
  startNewHistory(): Promise<string | null>
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
 * The message is written for the person who will see it, not for a log, and
 * since KV-95 it reaches the dashboard in that shape: the renderer reads the
 * sentence out from behind Electron's wrapper by its tag.
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
 * IPC — see `core/capture/failure.ts`. It is never shown: `failureDetail`
 * strips it, and Electron's wrapper with it, before a screen sees the sentence.
 */
export class UnreadableStoreError extends Error {
  constructor(path: string, why: string) {
    super(
      `${failureTag('store-unreadable')}: The check-in history at ${path} could not be read: ` +
        `${why}. Nothing has been changed.`,
    )
    this.name = 'UnreadableStoreError'
  }
}

/**
 * The history file exists but could not be opened at all: another program is
 * holding it, or its permissions refuse this app (KV-95 review).
 *
 * Until this existed the filesystem's own error went out untagged —
 * `EACCES: permission denied, open '…'` — and once the dashboard stopped
 * printing raw errors, a locked file left an empty dashboard with no cause
 * anywhere a caregiver could see. So it gets a tag and a sentence, like
 * `UnreadableStoreError`, but a different one of each: this failure can clear
 * on its own (a sync client lets go, a restore finishes), and that one cannot.
 * The filesystem's code is kept in the sentence, because it is what someone
 * helping will ask for, and the original error rides along as `cause`.
 */
export class UnreachableStoreError extends Error {
  constructor(path: string, code: string | undefined, cause: unknown) {
    super(
      `${failureTag('store-unreachable')}: The check-in history at ${path} could not be ` +
        `opened${code === undefined ? '' : ` (${code})`}. Another program may be using it, ` +
        'or its permissions may need checking. Nothing has been changed.',
      { cause },
    )
    this.name = 'UnreachableStoreError'
  }
}

/**
 * The history was written by a newer version of this app (KV-98 review).
 *
 * Not corruption: it is the person's whole history, in a format this build
 * does not read. It used to be an `UnreadableStoreError` like any other, which
 * meant *Start a new history* would set it aside — and a newer build installed
 * again afterwards would find no `sessions.json`, start from nothing, and never
 * look at the file set aside. So it has its own tag, the dashboard offers no
 * button for it, and `startNewHistory` refuses to move it: the fix is the newer
 * version, which reads it as it is. Migration is #30's.
 */
export class NewerStoreError extends Error {
  constructor(path: string, version: number) {
    super(
      `${failureTag('store-newer')}: The check-in history at ${path} was written by a newer ` +
        `version of Kinvue (file version ${String(version)}; this one reads version ` +
        `${String(FILE_VERSION)}). Nothing has been changed. The newer version can read it.`,
    )
    this.name = 'NewerStoreError'
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
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return empty()
    throw new UnreachableStoreError(path, code, err)
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
  if (typeof version === 'number' && Number.isFinite(version) && version > FILE_VERSION) {
    throw new NewerStoreError(path, version)
  }
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

/** How many same-day names to try before giving up with a sentence rather than hanging. */
const MAX_ASIDE_NAMES = 100

/** The local calendar day, as the person pressing the button would name it (KV-98 review). */
function localDay(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Sets an unreadable history aside beside itself, named for the day, and
 * returns where it went. Two bad files in one day get `-2`, `-3`.
 *
 * **Exclusive, not check-then-act.** `rename` silently replaces whatever is at
 * its destination, so a name that was free when checked could be taken by the
 * time the rename ran, and an earlier set-aside file would be gone. Instead the
 * bytes are copied with `COPYFILE_EXCL`, which fails rather than overwrite, and
 * only then is the original removed. If the removal fails the history is still
 * unreadable and a copy exists beside it — nothing is lost, and the next press
 * sets it aside under the next name.
 */
async function setAside(path: string, now: Date): Promise<string> {
  const base = `${path}.unreadable-${localDay(now)}`
  for (let n = 1; n <= MAX_ASIDE_NAMES; n++) {
    const candidate = n === 1 ? base : `${base}-${String(n)}`
    try {
      await copyFile(path, candidate, constants.COPYFILE_EXCL)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
    await unlink(path)
    await explainSetAside(path)
    return candidate
  }
  throw new Error(
    `The check-in history at ${path} could not be set aside: ${String(MAX_ASIDE_NAMES)} ` +
      'files for today already exist beside it. Nothing has been changed.',
  )
}

/**
 * A plain-text note beside the set-aside files, written once, so they still mean
 * something after the on-screen notice is gone (KV-98 review). Best-effort: the
 * history was already set aside, and failing to explain it must not undo that.
 */
async function explainSetAside(path: string): Promise<void> {
  try {
    await writeFile(
      `${path}.unreadable-README.txt`,
      [
        'Files named sessions.json.unreadable-<date> are check-in histories Kinvue could not',
        'read. When that happened, it offered to start a new history, and set the old file',
        'aside here instead of deleting it. Each is kept exactly as it was, for someone to',
        'look at. Kinvue does not read them again.',
        '',
      ].join('\n'),
      { encoding: 'utf8', flag: 'wx' },
    )
  } catch {
    /* already written, or not writable: the file set aside is what matters */
  }
}

export function createJsonSessionStore(
  path: string,
  now: () => Date = () => new Date(),
): SessionStore {
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
    /**
     * Person-initiated, never automatic, and it never deletes a byte: the file
     * is copied aside and only then removed (see `setAside`), and the next read
     * finds no history and starts a fresh one
     * (KV-98). Code that quietly set a file aside on its own would be the
     * silent-empty fallback #13 removed, wearing a hat.
     *
     * **It re-checks before it moves anything.** Only a file that is unreadable
     * *now* is set aside. One that reads — fixed by hand, or restored by a sync
     * client since the dashboard showed the error — is left exactly where it is
     * and null comes back, because moving a readable history out from under the
     * person is the one thing this must never do. A missing file is likewise
     * null: there is nothing to set aside. A file that cannot be opened at all
     * (`UnreachableStoreError`) is not moved either; that error is rethrown, since
     * whatever is holding the file may hold it against a rename too. A file from a
     * newer version of the app (`NewerStoreError`) is rethrown too: it is a whole
     * history, not a broken one, and setting it aside would strand it.
     */
    async startNewHistory() {
      try {
        await read(path)
        return null
      } catch (err) {
        if (!(err instanceof UnreadableStoreError)) throw err
      }
      return await setAside(path, now())
    },
  }
}
