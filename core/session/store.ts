import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { failureTag } from '../capture/failure'
import { asAskedNow } from './answers'
import { checkRecord, checkTombstone, isInstant, NOT_A_RECORD } from './check'
import { checkFormat, RECORD_FORMAT, sameRecord } from './format'
import {
  EXPORT_KIND,
  exportOf,
  planRestore,
  remove as removeFrom,
  type HistoryExport,
  type Removal,
  type RestorePlan,
} from './lifecycle'
import type { SessionRecord, Tombstone } from './types'

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
  /**
   * Append one session. Sessions are never edited in place.
   *
   * **Idempotent** (KV-30): a record already stored, arriving again, is one
   * record, and nothing is written. A *different* record under a stored id is
   * refused, not merged and not treated as a duplicate — ids are never reused,
   * so it is a bug or a forgery, and either answer would lose one of the two
   * unseen. Any store behind this seam keeps both rules, the caregiver's
   * client's included (KV-34).
   */
  append(record: SessionRecord): Promise<void>
  /** Every person with at least one session. */
  people(): Promise<string[]>
  /**
   * Sets an unreadable history aside so a new, empty one can begin (KV-98).
   * Returns where the old file now is, or null when there was nothing to set
   * aside — see the implementation for why a readable file is never moved.
   */
  startNewHistory(): Promise<string | null>
  /**
   * Deletes the check-ins of `personId` that `which` names (KV-21), keeping a
   * tombstone for each real one, in one write. Returns how many were deleted.
   */
  remove(personId: string, which: Removal, now: Date): Promise<number>
  /** `personId`'s history as a restorable export. Reads; writes nothing. */
  exportFor(personId: string, now: Date): Promise<HistoryExport>
  /** Records that `personId`'s history was exported at `at`, for the line beside the control. */
  markExported(personId: string, at: Date): Promise<void>
  /** When `personId`'s history was last exported, or null for never. */
  lastExported(personId: string): Promise<string | null>
  /**
   * Restores an export into `personId`'s history: everything it accepts, in one
   * write, or nothing (KV-21). Returns what it did, or why it refused.
   */
  restore(personId: string, file: unknown): Promise<RestorePlan>
  /**
   * Seals a plain history with the cipher, where the cipher encrypts, in one
   * write (KV-175): at start, so an install only read from does not stay plain.
   * Resolves true if it wrote. A missing or already sealed history is left alone.
   */
  encryptAtRest(): Promise<boolean>
  /**
   * What is on disk, read without opening it (review of #187): sealed, plain,
   * or nothing yet — no file, an empty one, or a history with no check-ins and
   * no deletions. What the dashboard's protection line is a statement about.
   * Anything it cannot make sense of is `plain`: it never says "sealed" of a
   * file it does not know is.
   */
  atRest(): Promise<AtRest>
}

/** What `atRest` found on disk. */
export type AtRest = 'sealed' | 'plain' | 'nothing'

/**
 * How the history is encrypted at rest (KV-175): handed to the store from
 * `app/main`, where it is built from Electron's `safeStorage`, so `core/` never
 * imports Electron (KV-15) and the tests run with a stand-in in plain node.
 *
 * Sealed text travels as base64, so nothing here handles a key or a buffer.
 */
export interface StoreCipher {
  /**
   * Whether this cipher encrypts at all: false where the operating system holds
   * no real key store (Linux `basic_text`), and for the plain cipher. A history
   * written through one that does not is written plain.
   */
  readonly encrypts: boolean
  /**
   * Whether the key store can be reached right now. Asked before opening, to
   * tell "not available — it may be locked" (retryable, never set aside) from
   * "answered, and still would not open" (review of #186).
   */
  available(): boolean
  /**
   * Whether this platform can fail to open a history for a locked key store in
   * a way that looks like an answer — macOS, where a dismissed Keychain prompt
   * may — so the undecryptable sentence says to try the next launch first.
   */
  readonly lockedLooksLikeForeign: boolean
  /** `text` sealed, as base64. */
  seal(text: string): string
  /** The text `sealed` (base64) was sealed from. Throws when it will not open. */
  open(sealed: string): string
}

/** No encryption: the cipher a store gets where nothing else is given, and the tests'. */
export const PLAIN_CIPHER: StoreCipher = {
  encrypts: false,
  available: () => false,
  lockedLooksLikeForeign: false,
  seal: () => {
    throw new Error('The plain cipher does not seal.')
  },
  open: () => {
    throw new Error('The plain cipher does not open.')
  },
}

/**
 * The version an encrypted history's envelope says (KV-175). Above every plain
 * file a build from before KV-175 knows, so such a build refuses it as written
 * by a newer version and leaves it alone. Apart from `FILE_VERSION`, which the
 * sealed file keeps inside: a change any older build must not read, at either
 * level, raises this one (ARCHITECTURE.md, review of #186).
 */
const ENVELOPE_VERSION = 2

/**
 * The version this code writes and is willing to read.
 *
 * Read, not decoration (KV-13). It was written on every save and checked
 * nowhere, which implies a migration story that does not exist — and a file
 * from a later version would have been read as though it were this one, which
 * is the quiet kind of wrong. This is only about the file: each record carries
 * its own format as well (`RECORD_FORMAT`, KV-30), checked as the file is read,
 * so a record in a newer format is refused without this having to change.
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
  /**
   * What is kept of deleted check-ins (KV-21), checked as they are read.
   * Absent until the first deletion, so a file nothing was ever deleted from
   * is written back exactly as before.
   */
  removed?: Tombstone[]
  /**
   * When each person's history was last exported (KV-21): display only, for
   * the line beside the export control. Not checked: an entry that is not a
   * time reads as "never", since refusing a whole history over a date that
   * only feeds a sentence would cost far more than it protects.
   */
  lastExported?: Record<string, unknown>
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
 * version, which reads it as it is. There is no migration to offer instead:
 * records are never rewritten into another format (KV-30).
 *
 * **Raised for one newer record as well as for a newer file** (KV-30): a
 * history holding a check-in this build cannot read is refused whole, as a
 * newer file is. Leaving that one out would score every later check-in against
 * a usual missing a day, with nothing to say so. And it would not stop there:
 * the check runs in `read`, which `append` uses too, so a record filtered out
 * here would be pushed past and the file renamed over without it — the record
 * gone, not merely misread (review of #182). Only a filter in `list` alone
 * would leave `append` writing it back untouched.
 *
 * Whole, and not just for the person it belongs to: a record in a format this
 * build does not know cannot be trusted to say whose it is. A viewer, which
 * knows that from the share and never rescores, holds such a record aside
 * instead (ARCHITECTURE.md, KV-30).
 */
export class NewerStoreError extends Error {
  constructor(path: string, version: number, of: 'file' | 'record') {
    super(
      of === 'file'
        ? `${failureTag('store-newer')}: The check-in history at ${path} was written by a ` +
            `newer version of Kinvue (file version ${String(version)}; this one reads version ` +
            `${String(FILE_VERSION)}). Nothing has been changed. The newer version can read it.`
        : `${failureTag('store-newer')}: The check-in history at ${path} holds check-ins ` +
            `written by a newer version of Kinvue (record format ${String(version)}; this one ` +
            `reads format ${String(RECORD_FORMAT)}). Nothing has been changed. The newer ` +
            'version can read it.',
    )
    this.name = 'NewerStoreError'
  }
}

/**
 * One entry in the history is not a check-in this build can read: not a
 * record at all, or one whose fields are not what their types say — its
 * format first (KV-30), then every field (KV-181, `checkRecord`).
 *
 * **Never set aside** (review of #182). It began as an `UnreadableStoreError`,
 * which offers *Start a new history* — so one hand-edited or half-merged entry
 * among months of good ones put a button under the sentence that would archive
 * the whole baseline. The file is as intact as a newer one, and better
 * understood than nothing, so it is refused the same way: whole, every time,
 * with a sentence saying which entry and that the rest is fine. Refused whole
 * because an entry this build cannot read cannot be trusted to say whose it
 * is, so it cannot be left out of one person's history and not another's.
 */
export class UnrecognisedRecordError extends Error {
  /**
   * `why` is `checkRecord`'s reason, or `checkTombstone`'s, naming the field:
   * whoever opens the file needs it. `of` says which list the entry is in — a
   * deletion record is load-bearing too (KV-21), since it is what keeps a
   * deleted check-in deleted. `position` is null when it is the list itself
   * that cannot be read, which has no entry to point at (review of #185).
   */
  constructor(
    path: string,
    position: number | null,
    total: number,
    why: string,
    of: 'check-ins' | 'deletions',
  ) {
    const what =
      position === null
        ? `The list of deleted check-ins in the check-in history at ${path} cannot be read ` +
          `(${why})`
        : of === 'deletions'
        ? `Deletion record ${String(position)} of ${String(total)} in the check-in history at ` +
          `${path} cannot be read (${why})`
        : `Entry ${String(position)} of ${String(total)} in the check-in history at ${path} ` +
          (why === NOT_A_RECORD
            ? 'is not a check-in at all'
            : `is a check-in this app cannot read (${why})`)
    super(
      `${failureTag('store-record-unknown')}: ${what}. Nothing has been changed, and the rest ` +
        'of the history is intact; the file needs someone to look at that entry.',
    )
    this.name = 'UnrecognisedRecordError'
  }
}

/**
 * The history is encrypted, and this computer's key store cannot be reached
 * right now — locked, or not yet unlocked this session (KV-175, review of
 * #186). It should open once it can be, so nothing is offered that would move
 * it: setting it aside now would set aside a readable history, and the re-read
 * that guards against that fails the same way while the key is out of reach.
 */
export class LockedStoreError extends Error {
  constructor(path: string) {
    super(
      `${failureTag('store-locked')}: The check-in history at ${path} is encrypted, and this ` +
        "computer's key store is not available just now. It may be locked. Nothing has been " +
        'changed; it should open once the key store is available.',
    )
    this.name = 'LockedStoreError'
  }
}

/**
 * The key store answered, and the history still would not open with it
 * (KV-175): encrypted for another account or computer, or that key is gone —
 * after a password reset, a history can be readable nowhere. It will not open
 * here, so *Start a new history* is offered under it, keeping the file as it is.
 * Where a locked key store can look like this one (`lockedLooksLikeForeign`,
 * macOS), the sentence says to try the next launch first.
 */
export class UndecryptableStoreError extends Error {
  constructor(path: string, lockedLooksLikeForeign: boolean) {
    super(
      `${failureTag('store-undecryptable')}: The check-in history at ${path} could not be ` +
        "opened with this account's key. It may have been encrypted for another account or " +
        'computer, or that key may be gone, after a password reset. ' +
        (lockedLooksLikeForeign
          ? "If this computer's key store was locked, it may open on the next launch: try " +
            'that first. '
          : '') +
        'Nothing has been changed. To move a history to another computer, restore an export ' +
        'there.',
    )
    this.name = 'UndecryptableStoreError'
  }
}

/**
 * The plain file inside an encrypted history's envelope, parsed, for the
 * ordinary checks to read as if it had been on disk (KV-175).
 */
function opened(path: string, envelope: Record<string, unknown>, cipher: StoreCipher): unknown {
  const sealed = envelope.sealed
  if (typeof sealed !== 'string' || sealed === '') {
    throw new UnreadableStoreError(path, 'it says it is encrypted, and holds nothing to open')
  }
  if (!cipher.available()) throw new LockedStoreError(path)
  let text: string
  try {
    text = cipher.open(sealed)
  } catch {
    throw new UndecryptableStoreError(path, cipher.lockedLooksLikeForeign)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new UnreadableStoreError(path, 'it opened, and what it holds is not valid JSON')
  }
}

/**
 * Only what it actually checks: an object with a `sessions` array. The version
 * is checked separately, before this, and so is each record's format (KV-30),
 * after it, and then every field of each (KV-181, `checkRecord`). `isFileShape`
 * itself still says nothing about what is *in* `sessions`.
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

async function read(path: string, cipher: StoreCipher): Promise<FileShape> {
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

  // An export where the history should be (review of #187): both are `.json`,
  // and a protected one carries `sealed` as the envelope does. Named for what
  // it is, before anything takes it for an envelope and blames a key — and the
  // sentence says the way back, which the button beside it begins.
  if ((parsed as { kind?: unknown }).kind === EXPORT_KIND) {
    throw new UnreadableStoreError(
      path,
      'it is an export, not the history itself. Start a new history, then restore the export ' +
        'into it',
    )
  }

  // An encrypted history (KV-175): opened first, then read as any file is.
  // Known by its `sealed` field, not by its version, so the envelope's version
  // and the plain file's `FILE_VERSION` stay two axes: a plain file of a later
  // format is still refused as newer, below, and never mistaken for a sealed one.
  if (isEnvelope(parsed)) {
    const outer: unknown = parsed.version
    if (typeof outer === 'number' && Number.isFinite(outer) && outer > ENVELOPE_VERSION) {
      throw new NewerStoreError(path, outer, 'file')
    }
    if (outer !== ENVELOPE_VERSION) {
      throw new UnreadableStoreError(path, 'it says it is encrypted, and not which way')
    }
    parsed = opened(path, parsed, cipher)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new UnreadableStoreError(path, 'it opened, and what it holds is not a history')
    }
  }

  // Version before shape, because a file from a later version is precisely the
  // one most likely to differ in shape. Checked the other way round, a version
  // 2 file that renamed `sessions` was refused with "it has no list of
  // sessions" — a claim about the person's data — instead of the version
  // mismatch, which names the real problem and implies the fix (KV-13 review).
  const version: unknown = (parsed as { version?: unknown }).version
  if (typeof version === 'number' && Number.isFinite(version) && version > FILE_VERSION) {
    throw new NewerStoreError(path, version, 'file')
  }
  if (version !== FILE_VERSION) {
    throw new UnreadableStoreError(path, describeVersion(version))
  }
  if (!isFileShape(parsed)) {
    throw new UnreadableStoreError(path, 'it has no list of sessions')
  }

  // Each record's format before anything else about it is trusted (KV-30), and
  // a newer one before a broken one, for the same reason as the file's version.
  const records: unknown[] = parsed.sessions
  const newer = records.find((r) => isObject(r) && checkFormat(r) === 'newer')
  if (newer !== undefined) {
    throw new NewerStoreError(path, (newer as { format: number }).format, 'record')
  }
  // Then every field of every entry (KV-181). Refused whole, like a newer
  // record: an entry this build cannot read cannot say whose it is.
  for (const [i, record] of records.entries()) {
    const why = checkRecord(record)
    if (why !== null) {
      throw new UnrecognisedRecordError(path, i + 1, records.length, why, 'check-ins')
    }
  }
  // What is kept of deleted check-ins, the same way (KV-21): a tombstone this
  // build cannot read could not keep its check-in deleted.
  const removed: unknown = (parsed as { removed?: unknown }).removed
  if (removed !== undefined) {
    if (!Array.isArray(removed)) {
      throw new UnrecognisedRecordError(path, null, 0, 'it is not a list', 'deletions')
    }
    for (const [i, tombstone] of removed.entries()) {
      const why = checkTombstone(tombstone)
      if (why !== null) {
        throw new UnrecognisedRecordError(path, i + 1, removed.length, why, 'deletions')
      }
    }
  }
  return parsed
}

/** The history `read` returned, as the lifecycle functions take it. */
const historyOf = (data: FileShape): { sessions: SessionRecord[]; removed: Tombstone[] } => ({
  sessions: data.sessions,
  removed: data.removed ?? [],
})

/** `data` with `history` in it, `removed` written only once there is something in it. */
function withHistory(
  data: FileShape,
  history: { sessions: SessionRecord[]; removed: Tombstone[] },
): FileShape {
  const next: FileShape = { ...data, sessions: history.sessions }
  if (history.removed.length > 0) next.removed = history.removed
  else delete next.removed
  return next
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Written via a temp file and a rename so a crash mid-write cannot truncate
 * the history. Losing a day's check-in is recoverable; losing the baseline the
 * comparisons depend on is not.
 */
async function write(path: string, data: FileShape, cipher: StoreCipher): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const plain = JSON.stringify(data, null, 2)
  // Sealed where the cipher encrypts (KV-175), so the temporary file is
  // ciphertext too: what a crash or a deletion leaves on disk is never plain.
  const text = cipher.encrypts
    ? JSON.stringify({ version: ENVELOPE_VERSION, sealed: cipher.seal(plain) }, null, 2)
    : plain
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * Whether `value` is an encrypted history's envelope: one with a `sealed`
 * field, and no `kind` — a protected export has `sealed` too, and says what it
 * is (review of #187).
 */
const isEnvelope = (value: object): value is Record<string, unknown> =>
  !Array.isArray(value) && Object.hasOwn(value, 'sealed') && !Object.hasOwn(value, 'kind')

/** What the file at `path` holds, read without opening it: see `SessionStore.atRest`. */
async function atRest(path: string): Promise<AtRest> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? 'nothing' : 'plain'
  }
  if (text.trim() === '') return 'nothing'
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'plain'
  }
  if (!isObject(parsed)) return 'plain'
  if (isEnvelope(parsed)) return 'sealed'
  const { sessions, removed } = parsed
  const none = (list: unknown): boolean => Array.isArray(list) && list.length === 0
  return none(sessions) && (removed === undefined || none(removed)) ? 'nothing' : 'plain'
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
  cipher: StoreCipher = PLAIN_CIPHER,
): SessionStore {
  // Every read-modify-write runs one at a time (KV-175). The seal that waits for
  // the operating system's key can now land a few seconds after start, while a
  // check-in or a deletion may be writing; two at once would have the later
  // read miss the earlier write and drop it. In one process, never again.
  //
  // One queue per store, not per file (review of #187): two stores made on the
  // same path would write past each other. So there is one, made once in
  // `app/main`; a second caller shares that one rather than making its own.
  let tail: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }

  return {
    async list(personId) {
      const { sessions } = await read(path, cipher)
      return sessions
        .filter((s) => s.personId === personId)
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
        // A seeded day from before KV-16 read as the question asked now; only
        // ever here, on the way out, never in what `append` writes back.
        .map(asAskedNow)
    },
    /**
     * Read-modify-write, one at a time within this process (`exclusive`).
     *
     * Two writes genuinely at once would have the later read miss the earlier
     * write and drop it; in this process they now queue (KV-175). The
     * single-window guard in `app/main` means there is one process, so that is
     * every writer today — it stops holding the moment a second process writes
     * here, which is #39's problem to inherit.
     */
    append(record) {
      return exclusive(async () => {
        const data = await read(path, cipher)
        // A tombstone wins over the record it names (KV-21): a deleted check-in
        // arriving again stays deleted, and nothing is written.
        if ((data.removed ?? []).some((t) => t.id === record.id)) return
        const stored = data.sessions.find((s) => s.id === record.id)
        if (stored !== undefined) {
          // The same record again is the one already here: nothing to write.
          if (sameRecord(stored, record)) return
          // Untagged, so it reads as `unknown` and invites a retry — which is
          // right on the one path that appends: a submit tried again draws a new id.
          throw new Error(
            `The check-in history at ${path} already holds a different check-in with the id ` +
              `${record.id}. Check-ins are never replaced, so it was not stored. Nothing has ` +
              'been changed.',
          )
        }
        data.sessions.push(record)
        await write(path, data, cipher)
      })
    },
    async people() {
      const { sessions } = await read(path, cipher)
      return [...new Set(sessions.map((s) => s.personId))]
    },
    remove(personId, which, at) {
      return exclusive(async () => {
        const data = await read(path, cipher)
        const done = removeFrom(historyOf(data), personId, which, at)
        if (done.removed === 0) return 0
        await write(path, withHistory(data, done.history), cipher)
        return done.removed
      })
    },
    async exportFor(personId, at) {
      return exportOf(historyOf(await read(path, cipher)), personId, at)
    },
    markExported(personId, at) {
      return exclusive(async () => {
        const data = await read(path, cipher)
        // Kept only if it is the map it should be: a hand-edited string spread
        // here would be written back as junk (review of #185).
        const prior = isObject(data.lastExported) ? data.lastExported : {}
        const lastExported = { ...prior, [personId]: at.toISOString() }
        await write(path, { ...data, lastExported }, cipher)
      })
    },
    async lastExported(personId) {
      const at = (await read(path, cipher)).lastExported?.[personId]
      return isInstant(at) ? at : null
    },
    restore(personId, file) {
      return exclusive(async () => {
        const data = await read(path, cipher)
        const plan = planRestore(historyOf(data), personId, file)
        if (!plan.ok) return plan
        const newTombstones = plan.history.removed.length > historyOf(data).removed.length
        // One write, whole — or none, when nothing would change. Never a deletion:
        // a restore only adds check-ins, and tombstones that block (review of #185).
        if (plan.outcome.restored > 0 || newTombstones) {
          await write(path, withHistory(data, plan.history), cipher)
        }
        return plan
      })
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
    startNewHistory() {
      return exclusive(async () => {
        try {
          await read(path, cipher)
          return null
        } catch (err) {
          // A history that will not open with this account's key may be set aside
          // too (KV-175); one whose key store is only out of reach may not.
          if (!(err instanceof UnreadableStoreError || err instanceof UndecryptableStoreError)) {
            throw err
          }
        }
        return await setAside(path, now())
      })
    },
    encryptAtRest() {
      return exclusive(async () => {
        if (!cipher.encrypts || (await atRest(path)) === 'sealed') return false
        const data = await read(path, cipher)
        // Nothing on disk yet: the first write will be sealed anyway.
        if (data.sessions.length === 0 && data.removed === undefined) return false
        await write(path, data, cipher)
        return true
      })
    },
    atRest() {
      return atRest(path)
    },
  }
}
