import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportFileName, MAX_EXPORT_BYTES, readExport } from '../app/main/history-file'

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
      kind: 'read',
      contents: { kind: 'kinvue-history' },
    })
  })

  it('answers "not an export" for a file that is not JSON', async () => {
    expect(await readExport(await fileWith('a photo, perhaps'))).toEqual({ kind: 'not-an-export' })
  })

  it('answers "not an export" for a file too large to be one, without reading it', async () => {
    const path = await fileWith('')
    // Sparse: as large as the cap says, without writing 50 MB to find out.
    await truncate(path, MAX_EXPORT_BYTES + 1)
    expect(await readExport(path)).toEqual({ kind: 'not-an-export' })
  })

  it('says a file that would not open would not open, not that it is no export', async () => {
    // A directory stands in for a locked file: reading it fails the way a refused read does.
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-export-'))
    dirs.push(dir)
    expect(await readExport(dir)).toEqual({ kind: 'unopenable', code: 'EISDIR' })
    expect(await readExport(join(dir, 'gone.json'))).toEqual({ kind: 'unopenable', code: 'ENOENT' })
  })
})

describe('exportFileName', () => {
  it('names the local day it was made, which is what someone looks for among several', () => {
    expect(exportFileName(new Date(2026, 9, 5, 23, 30))).toBe('kinvue-history-2026-10-05.json')
    expect(exportFileName(new Date(2026, 0, 2, 0, 5))).toBe('kinvue-history-2026-01-02.json')
  })

  it('says a protected export is one, so it can be told apart unopened (review of #187)', () => {
    expect(exportFileName(new Date(2026, 9, 5, 9, 0), true)).toBe(
      'kinvue-history-2026-10-05-protected.json',
    )
    expect(exportFileName(new Date(2026, 9, 5, 9, 0), false)).toBe('kinvue-history-2026-10-05.json')
  })
})
