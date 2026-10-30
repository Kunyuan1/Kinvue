import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportFileName,
  MAX_EXPORT_BYTES,
  NAME_BYTES_IN_FILE_NAME,
  nameForFile,
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
    expect(exportFileName(new Date(2026, 9, 5, 23, 30), null)).toBe(
      'kinvue-history-2026-10-05.json',
    )
    expect(exportFileName(new Date(2026, 0, 2, 0, 5), null)).toBe('kinvue-history-2026-01-02.json')
  })

  it('says a protected export is one, so it can be told apart unopened (review of #187)', () => {
    expect(exportFileName(new Date(2026, 9, 5, 9, 0), null, true)).toBe(
      'kinvue-history-2026-10-05-protected.json',
    )
    expect(exportFileName(new Date(2026, 9, 5, 9, 0), null, false)).toBe(
      'kinvue-history-2026-10-05.json',
    )
  })

  it('says whose it is, so two people exported on one day are not one name (KV-209)', () => {
    const day = new Date(2026, 9, 5, 9, 0)
    expect(exportFileName(day, 'Ann')).toBe('kinvue-history-Ann-2026-10-05.json')
    expect(exportFileName(day, 'Bill')).toBe('kinvue-history-Bill-2026-10-05.json')
  })

  it('never says whose a protected export is: its name is outside the passphrase (#210)', () => {
    const day = new Date(2026, 9, 5, 9, 0)
    expect(exportFileName(day, 'Ann', true)).toBe('kinvue-history-2026-10-05-protected.json')
    expect(exportFileName(day, 'Bill', true)).toBe('kinvue-history-2026-10-05-protected.json')
  })
})

describe('nameForFile (KV-209)', () => {
  it('keeps a name in any script, and its joiners', () => {
    expect(nameForFile('José')).toBe('José')
    expect(nameForFile('王芳')).toBe('王芳')
    // A Persian name spelled with a zero-width non-joiner, as KV-18's name rule allows.
    expect(nameForFile('نیلو\u200cفر')).toBe('نیلو\u200cفر')
  })

  it('turns spaces and what Windows refuses into one hyphen each run', () => {
    expect(nameForFile('Mary Ann')).toBe('Mary-Ann')
    expect(nameForFile('A/B\\C:D*E?F"G<H>I|J')).toBe('A-B-C-D-E-F-G-H-I-J')
    expect(nameForFile('Ann  -  Bill')).toBe('Ann-Bill')
    expect(nameForFile('J. Smith')).toBe('J.-Smith')
  })

  it('leaves no dot or hyphen at either end, where Windows drops a dot', () => {
    expect(nameForFile('..Ann.')).toBe('Ann')
    expect(nameForFile(' -Ann- ')).toBe('Ann')
  })

  it('leaves nothing of a name with nothing a file name can hold, and the day alone', () => {
    expect(nameForFile('???')).toBe('')
    expect(exportFileName(new Date(2026, 9, 5, 9, 0), '???')).toBe('kinvue-history-2026-10-05.json')
  })

  it('cuts a long name between characters, short of the bytes allowed', () => {
    // A family, four people joined: one character, 25 bytes.
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}'
    expect(Buffer.byteLength(family, 'utf8')).toBe(25)
    const kept = nameForFile(family.repeat(40))
    expect(kept).toBe(family.repeat(2))
    expect(Buffer.byteLength(kept, 'utf8')).toBeLessThanOrEqual(NAME_BYTES_IN_FILE_NAME)
    expect(nameForFile('a'.repeat(40))).toBe('a'.repeat(40))
    // Cut just after a space, it ends in no hyphen.
    expect(nameForFile(`${'a'.repeat(59)} bc`)).toBe('a'.repeat(59))
  })
})
