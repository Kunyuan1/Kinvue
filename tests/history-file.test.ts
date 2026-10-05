import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportFileName,
  MAX_EXPORT_BYTES,
  NOT_AN_EXPORT,
  readExport,
} from '../app/main/history-file'

/** Reading and naming an exported history (KV-21), in plain node. */

const dirs: string[] = []
async function fileWith(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kinvue-export-'))
  dirs.push(dir)
  const path = join(dir, 'history.json')
  await writeFile(path, text, 'utf8')
  return path
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (d) => rm(d, { recursive: true, force: true })))
})

describe('readExport', () => {
  it('reads a file as JSON, leaving what it holds for planRestore to check', async () => {
    expect(await readExport(await fileWith('{"kind":"kinvue-history"}'))).toEqual({
      kind: 'kinvue-history',
    })
  })

  it('answers "not an export" for a file that is not JSON', async () => {
    expect(await readExport(await fileWith('a photo, perhaps'))).toBe(NOT_AN_EXPORT)
  })

  it('answers "not an export" for a file too large to be one, without reading it', async () => {
    const path = await fileWith('')
    // Sparse: as large as the cap says, without writing 50 MB to find out.
    await truncate(path, MAX_EXPORT_BYTES + 1)
    expect(await readExport(path)).toBe(NOT_AN_EXPORT)
  })
})

describe('exportFileName', () => {
  it('names the local day it was made, which is what someone looks for among several', () => {
    expect(exportFileName(new Date(2026, 9, 5, 23, 30))).toBe('kinvue-history-2026-10-05.json')
    expect(exportFileName(new Date(2026, 0, 2, 0, 5))).toBe('kinvue-history-2026-01-02.json')
  })
})
