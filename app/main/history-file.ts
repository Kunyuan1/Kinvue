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

/** What `readExport` gives back for a file that is not an export at all. */
export const NOT_AN_EXPORT = Symbol('not an export')

/**
 * The parsed contents of the file at `path`, or `NOT_AN_EXPORT` when it is too
 * large to be one or is not JSON. What it holds is checked by `planRestore`,
 * not here: this only gets it off the disk.
 */
export async function readExport(path: string): Promise<unknown> {
  if ((await stat(path)).size > MAX_EXPORT_BYTES) return NOT_AN_EXPORT
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return NOT_AN_EXPORT
  }
}

/**
 * The name the save dialog suggests: the local day it was made, which is what
 * the person will look for among several — `kinvue-history-2026-10-05.json`.
 */
export function exportFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `kinvue-history-${day}.json`
}
