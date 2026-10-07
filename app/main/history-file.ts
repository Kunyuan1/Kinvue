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
 * The name the save dialog suggests: the local day it was made, which is what
 * the person will look for among several — `kinvue-history-2026-10-05.json`.
 *
 * A protected export says so in its name (review of #187) —
 * `kinvue-history-2026-10-05-protected.json` — so the copy whose passphrase
 * must be remembered can be told from a plain one without opening it.
 */
export function exportFileName(now: Date, isProtected = false): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `kinvue-history-${day}${isProtected ? '-protected' : ''}.json`
}
