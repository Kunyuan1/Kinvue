import type { SessionRecord } from './types'

/**
 * The record format, carried by each record rather than only by the file
 * (KV-30). See ARCHITECTURE.md, "What a record carries on its own".
 *
 * A record has to make sense wherever it lands — on a viewer's phone, or read
 * back years after the code that wrote it has changed — and the file's own
 * `version` does not travel with it. So each record says which format it is
 * in, and a reader that does not know that format refuses the record rather
 * than reading it as one it does.
 *
 * **Bumped only when a reader of the old format would misread the new one**: a
 * field that changes meaning, or one that is renamed or removed. KV-16's meal
 * question would have been one — a reader expecting `eatenToday` would have
 * read a `skippedMeal` record as unanswered. Adding a field is not: every
 * reader leaves behind what it does not know (`toShared` does, by
 * construction), so bumping for one would only lock older readers out of
 * records they read correctly.
 *
 * **One number for both shapes a record is read in** (review of #182): as
 * stored, by an older build of the check-in app, and as it leaves
 * (`SharedRecord`), by a viewer. It is bumped when a reader of either would
 * misread the new — so a change to what leaves can need a bump with nothing
 * stored changing, and `tests/format.test.ts` pins the share tables beside
 * this number to make that a decision rather than an oversight. The cost runs
 * the other way: a change to a field that never leaves bumps it too, and a
 * viewer then holds back records it could have read until it is updated. Rare,
 * cleared by an update, and cheaper than two numbers kept in step by hand.
 *
 * Every record written before KV-30 is format 1, though none of them says so.
 * They are not rewritten to say it: history is append-only, and a migration
 * that edited every record on disk would be the riskiest write this file ever
 * made, to record a fact that is already true by definition. `formatOf` reads
 * the absence as 1.
 */
export const RECORD_FORMAT = 1

/**
 * Whether a record leaves its format unsaid, as every record from before
 * KV-30 does: the field absent, and nothing else. `null` is a value somebody
 * wrote, not a format left unsaid, so it is not read as 1 (review of #182) —
 * one definition, which `formatOf`, `checkFormat` and `sameRecord` all use.
 */
const formatUnsaid = (record: { format?: unknown }): boolean => record.format === undefined

/**
 * The format of a record already read: as written, or 1 for one from before
 * KV-30. Only for a record `checkFormat` has passed; it does not ask again.
 */
export function formatOf(record: Pick<SessionRecord, 'format'>): number {
  return formatUnsaid(record) ? 1 : (record.format as number)
}

/**
 * Whether this code can read a record's format, asked of a record as it was
 * found — on disk, or arriving — before anything else about it is trusted.
 * `newer` is a whole record this code does not understand; `unrecognised` is a
 * format field that is not a format at all.
 */
export function checkFormat(record: { format?: unknown }): 'readable' | 'newer' | 'unrecognised' {
  const format = formatUnsaid(record) ? 1 : record.format
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) return 'unrecognised'
  return format > RECORD_FORMAT ? 'newer' : 'readable'
}

/**
 * Whether two records are the same record: one id, and the same content.
 *
 * What makes a record arriving twice one record (KV-30). Compared on content,
 * not on id alone, because an id that turns up again with different content is
 * not a duplicate: on the check-in device ids are never reused, so it is a bug
 * or a forgery, and treating it as a duplicate would drop it unseen — or, as an
 * update, overwrite a record that is never edited. Two things that are not
 * part of what a record says are ignored: key order, which JSON written by
 * another client need not keep, and a format of 1 left unsaid, which is what a
 * record from before KV-30 means — the same record shared onward says it.
 */
export function sameRecord(a: SessionRecord, b: SessionRecord): boolean {
  const said = (r: SessionRecord): string => canonical({ ...r, format: formatOf(r) })
  return a.id === b.id && said(a) === said(b)
}

/** JSON with every object's keys sorted, so equal content gives equal text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  )
}
