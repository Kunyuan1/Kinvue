import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createJsonSessionStore,
  LockedStoreError,
  NewerStoreError,
  UndecryptableStoreError,
  UnreadableStoreError,
  type StoreCipher,
} from '@core/session/store'
import { classifyDashboardError, classifySubmitError } from '@core/capture/failure'
import { session } from './helpers'

/**
 * The history encrypted at rest (KV-175), with a stand-in for `safeStorage` so
 * this stays in plain node: the store is handed a cipher, and never imports
 * Electron. The stand-in reverses and base64s the text behind a key name, and
 * refuses to open anything sealed under another — enough to tell "would not
 * open" from "opened", which is all the store may rely on.
 */

function cipherFor(key: string, over: Partial<StoreCipher> = {}): StoreCipher {
  return {
    encrypts: true,
    available: () => true,
    lockedLooksLikeForeign: false,
    seal: (text) => Buffer.from(`${key}:${[...text].reverse().join('')}`).toString('base64'),
    open: (sealed) => {
      const text = Buffer.from(sealed, 'base64').toString()
      if (!text.startsWith(`${key}:`)) throw new Error('wrong key')
      return [...text.slice(key.length + 1)].reverse().join('')
    },
    ...over,
  }
}

const dirs: string[] = []
async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kinvue-sealed-'))
  dirs.push(dir)
  return join(dir, 'sessions.json')
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (d) => rm(d, { recursive: true, force: true })))
})

const ON = (): Date => new Date(2026, 9, 7, 10, 0)
const noted = session({ id: 'noted', answers: { painReported: true, painNote: 'left hip' } })

describe('a history encrypted at rest (KV-175)', () => {
  it('is written sealed, holds nothing readable on disk, and reads back as it was', async () => {
    const path = await storePath()
    const store = createJsonSessionStore(path, ON, cipherFor('mine'))
    await store.append(noted)
    const disk = await readFile(path, 'utf8')
    expect(JSON.parse(disk)).toEqual({ version: 2, sealed: expect.any(String) })
    for (const plain of ['left hip', 'test-person', 'noted', 'sessions']) {
      expect(disk, plain).not.toContain(plain)
    }
    expect(await store.list('test-person')).toEqual([noted])
  })

  it('stays plain where the cipher does not encrypt, as on Linux with no keyring', async () => {
    const path = await storePath()
    const store = createJsonSessionStore(path, ON, cipherFor('mine', { encrypts: false }))
    await store.append(noted)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('seals a plain history once, at start, and leaves a sealed or missing one alone', async () => {
    const path = await storePath()
    await createJsonSessionStore(path).append(noted)
    const store = createJsonSessionStore(path, ON, cipherFor('mine'))
    expect(await store.encryptAtRest()).toBe(true)
    expect(await readFile(path, 'utf8')).not.toContain('left hip')
    expect(await store.list('test-person')).toEqual([noted])
    expect(await store.encryptAtRest()).toBe(false)

    const nothingYet = createJsonSessionStore(await storePath(), ON, cipherFor('mine'))
    expect(await nothingYet.encryptAtRest()).toBe(false)
    const plainPath = await storePath()
    await createJsonSessionStore(plainPath).append(noted)
    const plainText = await readFile(plainPath, 'utf8')
    expect(await createJsonSessionStore(plainPath).encryptAtRest()).toBe(false)
    expect(await readFile(plainPath, 'utf8')).toBe(plainText)
  })
})

describe('a history that will not open is one of two things (review of #186)', () => {
  async function sealedBy(key: string): Promise<{ path: string; text: string }> {
    const path = await storePath()
    await createJsonSessionStore(path, ON, cipherFor(key)).append(noted)
    return { path, text: await readFile(path, 'utf8') }
  }

  it('a key store out of reach: retryable, and never set aside', async () => {
    const { path, text } = await sealedBy('mine')
    const store = createJsonSessionStore(path, ON, cipherFor('mine', { available: () => false }))
    const listed = await store.list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(LockedStoreError)
    expect(String(listed)).toMatch(/key store is not available just now\. It may be locked/)
    expect(classifyDashboardError(listed)).toBe('store-locked')
    expect(classifySubmitError(listed)).toBe('unknown')
    await expect(store.startNewHistory()).rejects.toBeInstanceOf(LockedStoreError)
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('a plain store meeting a sealed history: no key store, not "unreadable"', async () => {
    const { path } = await sealedBy('mine')
    const listed = await createJsonSessionStore(path).list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(LockedStoreError)
  })

  it('a key store that answered and would not open it: set aside on request, whole', async () => {
    const { path, text } = await sealedBy('another account')
    const store = createJsonSessionStore(path, ON, cipherFor('mine'))
    const listed = await store.list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(UndecryptableStoreError)
    expect(String(listed)).toMatch(/could not be opened with this account's key/)
    expect(String(listed)).toMatch(/restore an export there/)
    expect(String(listed)).not.toMatch(/try that first/)
    expect(classifyDashboardError(listed)).toBe('store-undecryptable')
    expect(classifySubmitError(listed)).toBe('store-unreadable')

    const aside = await store.startNewHistory()
    expect(aside).toMatch(/\.unreadable-2026-10-07$/)
    expect(await readFile(aside!, 'utf8')).toBe(text)
    expect(await store.list('test-person')).toEqual([])
  })

  it('says to try the next launch first where a locked store can look like an answer', async () => {
    const { path } = await sealedBy('another account')
    const macOS = cipherFor('mine', { lockedLooksLikeForeign: true })
    const listed = await createJsonSessionStore(path, ON, macOS).list('test-person').catch((e) => e)
    expect(String(listed)).toMatch(/it may open on the next launch: try that first/)
  })
})

describe('the envelope itself', () => {
  async function fileOf(contents: unknown): Promise<string> {
    const path = await storePath()
    await writeFile(path, JSON.stringify(contents), 'utf8')
    return path
  }
  const listing = async (path: string): Promise<unknown> =>
    createJsonSessionStore(path, ON, cipherFor('mine')).list('test-person').catch((e: unknown) => e)

  it('refuses a newer envelope as newer, and leaves it alone', async () => {
    const path = await fileOf({ version: 3, sealed: 'abc' })
    const listed = await listing(path)
    expect(listed).toBeInstanceOf(NewerStoreError)
    const store = createJsonSessionStore(path, ON, cipherFor('mine'))
    await expect(store.startNewHistory()).rejects.toBeInstanceOf(NewerStoreError)
  })

  it('tells a plain file of a later format from a sealed one: newer, not "encrypted"', async () => {
    const listed = await listing(await fileOf({ version: 2, sessions: [] }))
    expect(listed).toBeInstanceOf(NewerStoreError)
    expect(String(listed)).toMatch(/file version 2/)
  })

  it('refuses an envelope it cannot make sense of, as an unreadable file', async () => {
    const cases: [unknown, RegExp][] = [
      [{ version: 'two', sealed: 'abc' }, /says it is encrypted, and not which way/],
      [{ version: 2, sealed: '' }, /says it is encrypted, and holds nothing to open/],
      [
        { version: 2, sealed: Buffer.from('mine:not json').toString('base64') },
        /opened, and what it holds is not valid JSON/,
      ],
    ]
    for (const [contents, why] of cases) {
      const listed = await listing(await fileOf(contents))
      expect(listed, JSON.stringify(contents)).toBeInstanceOf(UnreadableStoreError)
      expect(String(listed)).toMatch(why)
    }
  })

  it('leaves no plain temporary file behind a sealed write', async () => {
    const path = await storePath()
    await createJsonSessionStore(path, ON, cipherFor('mine')).append(noted)
    const dir = join(path, '..')
    for (const name of await readdir(dir)) {
      expect(await readFile(join(dir, name), 'utf8'), name).not.toContain('left hip')
    }
  })
})

describe('writes, one at a time (KV-175)', () => {
  it('keeps both of two check-ins appended at once, and a seal landing between them', async () => {
    // The seal that waits for the operating system's key can land while a
    // check-in is being written; neither may lose the other.
    const path = await storePath()
    await createJsonSessionStore(path).append(session({ id: 'first' }))
    const store = createJsonSessionStore(path, ON, cipherFor('mine'))
    await Promise.all([
      store.append(session({ id: 'a', capturedAt: '2026-09-16T09:00:00.000Z' })),
      store.encryptAtRest(),
      store.append(session({ id: 'b', capturedAt: '2026-09-17T09:00:00.000Z' })),
    ])
    expect((await store.list('test-person')).map((r) => r.id)).toEqual(['first', 'a', 'b'])
  })
})

