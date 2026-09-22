import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonSessionStore, UnreadableStoreError } from '@core/session/store'
import { session } from './helpers'

/**
 * The file every comparison rests on, which had no test (KV-13).
 * `ARCHITECTURE.md` makes a durability claim about it — temp file, then
 * rename — that nothing verified.
 */
const dirs: string[] = []

async function storeIn(): Promise<{ path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kinvue-store-'))
  dirs.push(dir)
  return { path: join(dir, 'sessions.json') }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (d) => rm(d, { recursive: true, force: true })))
})

describe('createJsonSessionStore', () => {
  it('treats a missing file as the first run rather than an error', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)

    expect(await store.list('anyone')).toEqual([])
    expect(await store.people()).toEqual([])
  })

  it('round-trips an appended session', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'one' }))

    const got = await store.list('test-person')
    expect(got.map((s) => s.id)).toEqual(['one'])
  })

  it('returns only the person asked for', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'theirs' }))
    await store.append({ ...session({ id: 'someone-elses' }), personId: 'other-person' })

    expect((await store.list('test-person')).map((s) => s.id)).toEqual(['theirs'])
    expect((await store.list('other-person')).map((s) => s.id)).toEqual(['someone-elses'])
  })

  it('returns them oldest first, whatever order they were appended', async () => {
    // The baseline window takes the *last* N, so the order is load-bearing.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'later', capturedAt: '2026-09-03T09:00:00.000Z' }))
    await store.append(session({ id: 'earlier', capturedAt: '2026-09-01T09:00:00.000Z' }))
    await store.append(session({ id: 'middle', capturedAt: '2026-09-02T09:00:00.000Z' }))

    expect((await store.list('test-person')).map((s) => s.id)).toEqual([
      'earlier',
      'middle',
      'later',
    ])
  })

  it('lists every person with a session, once each', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'a' }))
    await store.append(session({ id: 'b' }))
    await store.append({ ...session({ id: 'c' }), personId: 'other-person' })

    expect((await store.people()).sort()).toEqual(['other-person', 'test-person'])
  })

  it('never edits a record in place', async () => {
    // Append-only is what makes a record safe to sync later (#30).
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    const first = session({ id: 'one', capturedAt: '2026-09-01T09:00:00.000Z' })
    await store.append(first)
    await store.append(session({ id: 'two', capturedAt: '2026-09-02T09:00:00.000Z' }))

    const got = await store.list('test-person')
    expect(got).toHaveLength(2)
    expect(got[0]).toEqual(first)
  })
})

describe('a file it cannot read', () => {
  it('refuses rather than reporting an empty history', async () => {
    // Answering "empty" would be the reassuring-and-wrong direction: a person
    // with months of check-ins would be shown none, with no sign anything was
    // amiss.
    const { path } = await storeIn()
    await writeFile(path, 'not json at all', 'utf8')

    await expect(createJsonSessionStore(path).list('p')).rejects.toThrow(UnreadableStoreError)
  })

  it('refuses a file whose sessions are not a list', async () => {
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ version: 1, sessions: { oops: true } }), 'utf8')

    await expect(createJsonSessionStore(path).list('p')).rejects.toThrow(/no list of sessions/)
  })

  it('does not overwrite a file it could not read', async () => {
    // The reason refusing matters. `append` is read-modify-write, so a read
    // that answered "empty" pushed one record onto nothing and renamed that
    // over the original — the history gone, on the one path where the app
    // already knew something was wrong.
    const { path } = await storeIn()
    const original = JSON.stringify({ version: 1, sessions: { oops: true } })
    await writeFile(path, original, 'utf8')

    await expect(createJsonSessionStore(path).append(session())).rejects.toThrow(
      UnreadableStoreError,
    )
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('refuses a version it does not write', async () => {
    // The field was written on every save and checked nowhere, so a file from
    // a later version would have been read as though it were this one.
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ version: 99, sessions: [session()] }), 'utf8')

    await expect(createJsonSessionStore(path).list('test-person')).rejects.toThrow(/version 99/)
  })

  it('says where the file is and that nothing was changed', async () => {
    // The message is what someone sees when their history will not open.
    const { path } = await storeIn()
    await writeFile(path, '{', 'utf8')

    await expect(createJsonSessionStore(path).list('p')).rejects.toThrow(
      /Nothing has been changed/,
    )
  })
})

describe('the temp-then-rename write', () => {
  it('leaves the original intact when the write fails', async () => {
    // The durability claim in ARCHITECTURE.md, which nothing verified. A
    // directory where the temp file belongs makes writeFile fail the way a
    // full disk would.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'safe', capturedAt: '2026-09-01T09:00:00.000Z' }))
    const before = await readFile(path, 'utf8')

    await mkdir(`${path}.tmp`, { recursive: true })
    await expect(store.append(session({ id: 'doomed' }))).rejects.toThrow()

    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await createJsonSessionStore(path).list('test-person')).map((s) => s.id)).toEqual([
      'safe',
    ])
  })

  it('creates the directory it is pointed at', async () => {
    // Electron hands this a path under userData that may not exist yet.
    const { path } = await storeIn()
    const nested = join(path, '..', 'deeper', 'sessions.json')
    const store = createJsonSessionStore(nested)

    await store.append(session({ id: 'one' }))
    expect((await store.list('test-person')).map((s) => s.id)).toEqual(['one'])
  })
})
