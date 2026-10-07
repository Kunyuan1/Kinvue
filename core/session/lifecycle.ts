import { checkRecord, checkTombstone, isInstant } from './check'
import { checkFormat, RECORD_FORMAT, sameRecord } from './format'
import type { SessionRecord, Tombstone } from './types'

/**
 * Exporting, restoring and deleting a person's history (KV-21). The policy is
 * ARCHITECTURE.md's "Exporting, deleting, and how long a history is kept";
 * this is that policy as pure functions, so the store, the main process and a
 * viewer read one implementation of it.
 *
 * Nothing here touches a file. The store reads its history, hands it here, and
 * writes back what comes out, once — so a deletion or a restore is one write,
 * whole, or no write at all.
 */

/** A history as the store holds it: the check-ins, and what is kept of deleted ones. */
export interface History {
  sessions: SessionRecord[]
  removed: Tombstone[]
}

/** Which of a person's check-ins to delete. */
export type Removal =
  /** One check-in, by its id. */
  | { kind: 'one'; id: string }
  /**
   * Every check-in captured before an instant: midnight at the start of the
   * chosen date, in the device's zone when the person deletes (KV-21). One
   * instant, compared with each `capturedAt`, so a record with no zone is
   * decided like any other.
   */
  | { kind: 'before'; before: string }
  /** The whole history. */
  | { kind: 'all' }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The removal, or null if `input` is not one. For what crosses from the
 * renderer: rebuilt field by field, so nothing the caller added rides along.
 */
export function parseRemoval(input: unknown): Removal | null {
  if (!isObject(input)) return null
  if (input.kind === 'all') return { kind: 'all' }
  if (input.kind === 'one' && typeof input.id === 'string' && input.id !== '') {
    return { kind: 'one', id: input.id }
  }
  if (input.kind === 'before' && isInstant(input.before)) {
    return { kind: 'before', before: input.before }
  }
  return null
}

/** The check-ins of `personId` that `which` names, oldest first. */
export function chosenFor(
  sessions: readonly SessionRecord[],
  personId: string,
  which: Removal,
): SessionRecord[] {
  return sessions
    .filter((r) => r.personId === personId)
    .filter((r) =>
      which.kind === 'all'
        ? true
        : which.kind === 'one'
          ? r.id === which.id
          : r.capturedAt < which.before,
    )
    .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0))
}

/**
 * `history` with the check-ins `which` names removed, and a tombstone kept for
 * each real one. A seeded day leaves none: it never leaves the device, and its
 * id repeats across installs, so a tombstone for it exported and restored
 * elsewhere would delete another install's demo day (KV-21).
 */
export function remove(
  history: History,
  personId: string,
  which: Removal,
  now: Date,
): { history: History; removed: number } {
  const going = new Set(chosenFor(history.sessions, personId, which).map((r) => r.id))
  if (going.size === 0) return { history, removed: 0 }
  const removedAt = now.toISOString()
  const kept = new Set(history.removed.map((t) => t.id))
  const tombstones = history.sessions
    .filter((r) => going.has(r.id) && r.seeded !== true && !kept.has(r.id))
    .map((r): Tombstone => ({ id: r.id, personId: r.personId, removedAt }))
  return {
    history: {
      sessions: history.sessions.filter((r) => !going.has(r.id)),
      removed: [...history.removed, ...tombstones],
    },
    removed: going.size,
  }
}

/** What a file made by `exportOf` says it is. */
export const EXPORT_KIND = 'kinvue-history'

/**
 * The export container's own version (KV-21): the shape of an export, apart
 * from the store file's `version` (the shape of `sessions.json`) and each
 * record's `format` (the shape of a record, the same inside both).
 */
export const EXPORT_VERSION = 1

/**
 * The shortest passphrase a protected export takes (KV-175): it is the whole
 * defence. Here, not in `protect.ts`, so the screens can check it without
 * pulling `node:crypto` into the renderer.
 */
export const MIN_PASSPHRASE_LENGTH = 8

/** A person's history as it is exported: restorable by `planRestore`. */
export interface HistoryExport {
  kind: typeof EXPORT_KIND
  version: typeof EXPORT_VERSION
  exportedAt: string
  personId: string
  /** Their real check-ins exactly as stored. Seeded days are never exported. */
  records: SessionRecord[]
  /** What is kept of their deleted check-ins, so a restore cannot bring them back. */
  removed: Tombstone[]
}

/** `personId`'s history as a restorable export: records as stored, seeded days left out. */
export function exportOf(history: History, personId: string, now: Date): HistoryExport {
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    personId,
    records: chosenFor(history.sessions, personId, { kind: 'all' }).filter(
      (r) => r.seeded !== true,
    ),
    removed: history.removed.filter((t) => t.personId === personId),
  }
}

/** Why a file cannot be restored. Nothing is written for any of these. */
export type RestoreRefusal =
  | { kind: 'not-an-export' }
  /** The file could not be opened — held by another program, or refused by its permissions. */
  | { kind: 'unopenable'; code: string | undefined }
  /**
   * A protected export (KV-175) the passphrase did not open: the wrong one, or a
   * file changed since it was made — AES-GCM cannot say which, so both are said.
   */
  | { kind: 'wrong-passphrase' }
  /**
   * Made by a newer version: its container (`export`) or one of its records
   * (`record`), with the version it says — named in the sentence, as the store
   * names its own (review of #185).
   */
  | { kind: 'newer'; of: 'export' | 'record'; version: number }
  | { kind: 'someone-else' }
  | { kind: 'unreadable'; why: string }
  | { kind: 'entry'; position: number; total: number; why: string }

/** What a restore did. Skipped is an outcome reported, not a partial write. */
export interface RestoreOutcome {
  /** Check-ins added. */
  restored: number
  /** Check-ins in the file that were already here, the same. */
  alreadyHere: number
  /** Check-ins in the file deleted on this device, and so not restored. */
  stayDeleted: number
  /** When those were deleted here, as tombstone times — for the sentence. */
  deletedAt: string[]
  /**
   * Check-ins in the file that the file itself says were deleted where it was
   * made, and so not restored. Kept apart from `stayDeleted`: these were not
   * deleted on this device, and the sentence must not say they were (review
   * of #185).
   */
  deletedThere: number
}

export type RestorePlan =
  | { ok: true; history: History; outcome: RestoreOutcome }
  | { ok: false; refusal: RestoreRefusal }

/**
 * What a restore tells the screen: what it did, or why it refused. The plan's
 * merged history stays in the main process — the renderer reads the history
 * the way it always does, and is never handed a second copy of it.
 */
export type RestoreResult =
  | { ok: true; outcome: RestoreOutcome }
  | { ok: false; refusal: RestoreRefusal }

/**
 * The first step of a restore: a result, or — for a protected export (KV-175) —
 * a passphrase to ask for. The file waits in the main process for it; the
 * renderer is never handed the file.
 */
export type RestoreStep = RestoreResult | { needsPassphrase: true }

const refuse = (refusal: RestoreRefusal): RestorePlan => ({ ok: false, refusal })

/**
 * What restoring `file` into `history` for `personId` would do: the whole new
 * history and what changed, or why the file is refused (KV-21).
 *
 * Read in full before anything is decided, in the order ARCHITECTURE.md gives:
 * the container's kind and version; then each record's format, refused as a
 * whole file when newer, never entry by entry; then every field of every record
 * and every tombstone. Then the merge, by id: the same record is already here;
 * a different one under a held id refuses the file; a record with a tombstone,
 * here or in the file, is not restored.
 *
 * **Restoring never deletes** (review of #185). A tombstone in the file is kept
 * here only to stop that check-in arriving later — so an older export cannot
 * bring back what this one says was deleted — and is ignored for a check-in this
 * device holds. Deleting stays one action: the person's own, confirmed on
 * screen. A file is not signed (T16), so a restore that could delete would hand
 * that to whoever could edit the file. A refusal changes nothing.
 */
export function planRestore(history: History, personId: string, file: unknown): RestorePlan {
  if (!isObject(file) || file.kind !== EXPORT_KIND) return refuse({ kind: 'not-an-export' })
  const { version } = file
  if (typeof version === 'number' && Number.isFinite(version) && version > EXPORT_VERSION) {
    return refuse({ kind: 'newer', of: 'export', version })
  }
  if (version !== EXPORT_VERSION) {
    return refuse({ kind: 'unreadable', why: 'it does not say which version of an export it is' })
  }
  if (!Array.isArray(file.records) || !Array.isArray(file.removed)) {
    return refuse({ kind: 'unreadable', why: 'it has no list of check-ins' })
  }
  if (file.personId !== personId) return refuse({ kind: 'someone-else' })

  const records: unknown[] = file.records
  const tombstones: unknown[] = file.removed
  const newer = records.find((r) => isObject(r) && checkFormat(r) === 'newer')
  if (newer !== undefined) {
    return refuse({ kind: 'newer', of: 'record', version: (newer as { format: number }).format })
  }

  const total = records.length + tombstones.length
  for (const [i, record] of records.entries()) {
    const read = record as SessionRecord
    const why =
      checkRecord(record) ??
      (read.seeded === true ? 'it is demo data, which is never exported' : null) ??
      (read.personId !== personId ? 'it is someone else’s' : null)
    if (why !== null) return refuse({ kind: 'entry', position: i + 1, total, why })
  }
  for (const [i, tombstone] of tombstones.entries()) {
    const why =
      checkTombstone(tombstone) ??
      ((tombstone as Tombstone).personId !== personId ? 'it is someone else’s' : null)
    if (why !== null) return refuse({ kind: 'entry', position: records.length + i + 1, total, why })
  }

  const incoming = records as SessionRecord[]
  const theirDeletions = tombstones as Tombstone[]
  const deletedHere = new Map(history.removed.map((t) => [t.id, t]))
  const deletedThere = new Map(theirDeletions.map((t) => [t.id, t]))
  const held = new Map(history.sessions.map((r) => [r.id, r]))

  const added: SessionRecord[] = []
  const deletedAt: string[] = []
  let alreadyHere = 0
  let deletedWhereMade = 0
  for (const [i, record] of incoming.entries()) {
    // A tombstone wins over the record it names, whichever arrives first.
    const here = deletedHere.get(record.id)
    if (here !== undefined) {
      deletedAt.push(here.removedAt)
      continue
    }
    if (deletedThere.has(record.id)) {
      deletedWhereMade++
      continue
    }
    const stored = held.get(record.id)
    if (stored === undefined) {
      added.push(record)
      held.set(record.id, record)
    } else if (sameRecord(stored, record)) {
      alreadyHere++
    } else {
      return refuse({
        kind: 'entry',
        position: i + 1,
        total,
        why: 'it is a different check-in under an id this history already holds',
      })
    }
  }

  // Kept to block, never to remove: one naming a check-in held here is ignored.
  const blocking = theirDeletions.filter((t) => !deletedHere.has(t.id) && !held.has(t.id))
  return {
    ok: true,
    history: {
      sessions: [...history.sessions, ...added],
      removed: [...history.removed, ...blocking],
    },
    outcome: {
      restored: added.length,
      alreadyHere,
      stayDeleted: deletedAt.length,
      deletedAt,
      deletedThere: deletedWhereMade,
    },
  }
}

const checkIns = (n: number): string => `${String(n)} check-in${n === 1 ? '' : 's'}`
/** "the check-in" for one, "all 60 check-ins" for more. */
const the = (n: number): string => (n === 1 ? 'the check-in' : `all ${String(n)} check-ins`)
const was = (n: number): string => (n === 1 ? 'was' : 'were')
const is = (n: number): string => (n === 1 ? 'is' : 'are')
const stays = (n: number): string => (n === 1 ? 'stays' : 'stay')

/**
 * What the restore screen says it did, naming what it skipped (KV-21). `day`
 * names an instant's day in the device's zone: injected, so this stays free of
 * the clock and the zone and is tested as words.
 */
export function describeRestore(outcome: RestoreOutcome, day: (instant: string) => string): string {
  const { restored, alreadyHere, stayDeleted, deletedAt, deletedThere } = outcome
  const days = [...new Set(deletedAt.map(day))]
  const when = days.length === 1 ? ` on ${days[0]!}` : ''
  const deletedHere = `deleted on this device${when}, and ${stays(stayDeleted)} deleted`
  const there = `deleted where the file was made, and ${is(deletedThere)} not restored`
  if (restored === 0) {
    // Never "Restored 0 check-ins" (review of #185): what nothing was added for.
    if (alreadyHere + stayDeleted + deletedThere === 0) {
      return 'Nothing to restore: this file holds no check-ins.'
    }
    if (stayDeleted === 0 && deletedThere === 0) {
      return `Nothing to restore: ${the(alreadyHere)} in this file ${is(alreadyHere)} already here.`
    }
    if (alreadyHere === 0 && deletedThere === 0) {
      return `None restored: ${the(stayDeleted)} in this file ${was(stayDeleted)} ${deletedHere}.`
    }
    const here = `${checkIns(alreadyHere)} in this file ${is(alreadyHere)} already here`
    const why = [
      alreadyHere > 0 ? here : null,
      stayDeleted > 0 ? `${checkIns(stayDeleted)} ${was(stayDeleted)} ${deletedHere}` : null,
      deletedThere > 0 ? `${checkIns(deletedThere)} ${was(deletedThere)} ${there}` : null,
    ].filter((part) => part !== null)
    return `None restored: ${why.join('; ')}.`
  }
  const parts = [`Restored ${checkIns(restored)}.`]
  if (alreadyHere > 0) parts.push(`${checkIns(alreadyHere)} ${was(alreadyHere)} already here.`)
  if (stayDeleted > 0) parts.push(`${checkIns(stayDeleted)} ${was(stayDeleted)} ${deletedHere}.`)
  if (deletedThere > 0) parts.push(`${checkIns(deletedThere)} in it ${was(deletedThere)} ${there}.`)
  return parts.join(' ')
}

/** Why a file was not restored, in words for the person who chose it. Nothing was changed. */
export function describeRefusal(refusal: RestoreRefusal): string {
  const unchanged = ' Nothing has been changed.'
  switch (refusal.kind) {
    case 'not-an-export':
      return 'That file is not a Kinvue history export.' + unchanged
    case 'wrong-passphrase':
      return (
        'That passphrase does not open this file, or the file has changed since it was made.' +
        unchanged
      )
    case 'unopenable':
      return (
        `That file could not be opened${refusal.code === undefined ? '' : ` (${refusal.code})`}. ` +
        'Another program may be using it, or its permissions may need checking; it is worth ' +
        'another go.' + unchanged
      )
    case 'newer': {
      // Split, as `NewerStoreError` is: "a newer version of Kinvue, which can
      // restore it" read as a claim about this app (review of #185).
      const [what, unit, ours] =
        refusal.of === 'export'
          ? ['export version', 'version', EXPORT_VERSION]
          : ['record format', 'format', RECORD_FORMAT]
      const versions = `${what} ${String(refusal.version)}; this one reads ${unit} ${String(ours)}`
      return (
        `That file was made by a newer version of Kinvue (${versions}).` +
        unchanged +
        ' The newer version can restore it.'
      )
    }
    case 'someone-else':
      return 'That file is someone else’s history, not this one.' + unchanged
    case 'unreadable':
      return `That file cannot be restored: ${refusal.why}.` + unchanged
    case 'entry':
      return (
        `Entry ${String(refusal.position)} of ${String(refusal.total)} in that file cannot be ` +
        `restored: ${refusal.why}.` + unchanged
      )
  }
}

/**
 * The line beside the export control (KV-21): when the last export was made,
 * and how many check-ins have been taken since — what a dead device would take
 * with it — without a prompt or a schedule.
 */
export function describeLastExport(
  lastExportedAt: string | null,
  sessions: readonly SessionRecord[],
  day: (instant: string) => string,
): string {
  if (lastExportedAt === null) return 'Last exported: never.'
  const since = sessions.filter((r) => r.seeded !== true && r.capturedAt > lastExportedAt).length
  return `Last exported ${day(lastExportedAt)} (${checkIns(since)} since).`
}
