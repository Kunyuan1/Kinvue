import { readFile, stat } from 'node:fs/promises'

/**
 * Reading and naming an exported history (KV-21). No Electron here, so it is
 * tested in plain node; `index.ts` asks where with a dialog and calls these.
 */

/**
 * Larger than any history this app writes: a check-in is about a kilobyte, so
 * a decade of daily check-ins is a few megabytes. A file past this is not an
 * export, and reading it whole to find that out is not worth doing.
 */
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024

/**
 * What `readExport` found: the file's parsed contents; a file that is not an
 * export at all; or one that could not be opened. The last is kept apart
 * (review of #185): a file another program is holding, or whose permissions
 * refuse this app, may open next time, and calling it "not an export" would
 * send someone looking for the wrong problem — KV-95's distinction, for the
 * store, here for a file the person chose.
 */
export type ExportRead =
  | { kind: 'read'; contents: unknown }
  | { kind: 'not-an-export' }
  | { kind: 'unopenable'; code: string | undefined }

/**
 * The file at `path`, read and parsed. What it holds is checked by
 * `planRestore`, not here: this only gets it off the disk.
 */
export async function readExport(path: string): Promise<ExportRead> {
  let text: string
  try {
    if ((await stat(path)).size > MAX_EXPORT_BYTES) return { kind: 'not-an-export' }
    text = await readFile(path, 'utf8')
  } catch (err) {
    return { kind: 'unopenable', code: (err as NodeJS.ErrnoException).code }
  }
  try {
    return { kind: 'read', contents: JSON.parse(text) as unknown }
  } catch {
    return { kind: 'not-an-export' }
  }
}

/**
 * At most this many bytes of a person's name in a file name, in UTF-8. A name
 * is up to 40 characters, but a character may be many bytes — an emoji family
 * is 25 — and ext4 and APFS cap a whole file name at 255. Cut between
 * characters, never inside one.
 */
export const NAME_BYTES_IN_FILE_NAME = 60

/** Made once: building one resolves a locale, and it holds no state. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * `name` as it may stand in a file name on any of the three systems, or `''`
 * when nothing of it can. Any script stays: NTFS, APFS and ext4 all take it.
 * What goes is what one of them refuses or reads as a path — Windows' nine
 * reserved characters and control characters — and spaces, each run of them
 * and of those becoming one hyphen. The store's name rule already refuses the
 * invisible characters (KV-18), so the joiners some scripts spell with are all
 * that is left of those, and they stay. No dot or hyphen at either end: Windows
 * drops a trailing dot, and the name sits between hyphens.
 */
export function nameForFile(name: string): string {
  const plain = name
    .normalize('NFC')
    .replace(/[\s<>:"/\\|?*\p{Cc}-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  let kept = ''
  for (const { segment } of GRAPHEMES.segment(plain)) {
    if (Buffer.byteLength(kept + segment, 'utf8') > NAME_BYTES_IN_FILE_NAME) break
    kept += segment
  }
  // Cut short, the end may now be a dot or a hyphen.
  return kept.replace(/[-.]+$/, '')
}

/**
 * The name the save dialog suggests: whose it is and the local day it was
 * made, which is what the person will look for among several —
 * `kinvue-history-Ann-2026-10-05.json`. Since KV-18 an export is one person's,
 * and two people exported on one day must not be offered one name in one
 * folder. Someone not yet named, or whose name leaves nothing a file name can
 * hold, gets the day alone, as every export did before (KV-209).
 *
 * A protected export says so in its name (review of #187) —
 * `kinvue-history-2026-10-05-protected.json` — so the copy whose passphrase
 * must be remembered can be told from a plain one without opening it. It
 * never says whose: a passphrase covers everything inside the file, the name
 * included, but not the file's own name, and whoever chose one chose privacy
 * (decided by the owner in #210). The cost, taken on purpose: two protected
 * exports on one day are offered one name, and the dialog asks before
 * replacing on every system.
 */
export function exportFileName(now: Date, name: string | null, isProtected = false): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const whose = name === null || isProtected ? '' : nameForFile(name)
  const part = whose === '' ? '' : `${whose}-`
  return `kinvue-history-${part}${day}${isProtected ? '-protected' : ''}.json`
}
