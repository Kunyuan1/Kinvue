import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createJsonSessionStore,
  NewerStoreError,
  UnreachableStoreError,
  UnreadableStoreError,
} from '@core/session/store'
import { classifyDashboardError, classifySubmitError } from '@core/capture/failure'
import { session } from './helpers'

/**
 * A rename that can be made to fail once.
 *
 * `store.ts` does `import { rename } from 'node:fs/promises'`, so the binding
 * is resolved at import time and `vi.spyOn` on the namespace cannot reach it —
 * the module object is frozen. Everything else delegates to the real fs, so
 * the rest of the suite is untouched.
 */
const renameControl = vi.hoisted(() => ({ failNext: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (renameControl.failNext) {
        renameControl.failNext = false
        throw new Error('EIO: rename failed')
      }
      await actual.rename(from, to)
    },
  }
})

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

  it('treats a zero-byte file as a first run, because it has nothing to lose', async () => {
    // The one corruption with nothing to protect: refusing elsewhere is right
    // because answering "empty" would let `append` rename one record over real
    // history, and a zero-byte file holds none. `JSON.parse('')` throws, so
    // this was a permanent refusal protecting nothing.
    const { path } = await storeIn()
    await writeFile(path, '', 'utf8')

    const store = createJsonSessionStore(path)
    expect(await store.list('anyone')).toEqual([])
    // And it recovers rather than merely reading: the next check-in stores.
    await store.append(session({ id: 'after' }))
    expect((await store.list('test-person')).map((s) => s.id)).toEqual(['after'])
  })

  it('treats a whitespace-only file the same way', async () => {
    const { path } = await storeIn()
    await writeFile(path, '  \n', 'utf8')

    expect(await createJsonSessionStore(path).list('anyone')).toEqual([])
  })

  it('refuses a version it does not write', async () => {
    // The field was written on every save and checked nowhere, so a file from
    // a later version would have been read as though it were this one.
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ version: 99, sessions: [session()] }), 'utf8')

    await expect(createJsonSessionStore(path).list('test-person')).rejects.toThrow(/version 99/)
  })

  it('reaches the questions screen as its own failure, not as "try again"', async () => {
    // `submit` reads history before scoring, so this is raised after the
    // capture ran and the four questions were answered. The tag is the only
    // thing that survives IPC, so the throw and the classifier have to agree
    // here or the person is told to retry something that cannot succeed.
    const { path } = await storeIn()
    await writeFile(path, 'not json at all', 'utf8')

    const thrown = await createJsonSessionStore(path)
      .append(session())
      .catch((e: unknown) => e)
    expect(classifySubmitError(thrown)).toBe('store-unreadable')
    // As Electron hands it over, wrapped, which is how it actually arrives.
    expect(classifySubmitError(new Error(`Error invoking remote method 'x': ${String(thrown)}`))).toBe(
      'store-unreadable',
    )
  })

  it('blames the version, not the data, when a newer file also changed shape', async () => {
    // The scenario the version check exists for, and the one where the order
    // of the checks decided the message. Version 2 renaming `sessions` failed
    // the shape check first and was reported as "it has no list of sessions" —
    // a claim about the person's data rather than the real problem.
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ version: 2, records: [] }), 'utf8')

    const thrown = await createJsonSessionStore(path)
      .list('p')
      .catch((e: unknown) => e)
    expect(String(thrown)).toMatch(/version 2/)
    expect(String(thrown)).not.toMatch(/no list of sessions/)
  })

  it('does not report a version nobody wrote', async () => {
    // Interpolating the value gave "it is version undefined" for a file with
    // no version key, and "[object Object]" for a non-number — both reading as
    // though the file had declared something odd.
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ sessions: [] }), 'utf8')

    const thrown = await createJsonSessionStore(path)
      .list('p')
      .catch((e: unknown) => e)
    expect(String(thrown)).toMatch(/does not say which version/)
    expect(String(thrown)).not.toMatch(/undefined|\[object Object\]|NaN/)
  })

  it('reports a version it can read, even an odd one', async () => {
    // "does not say which version" would be untrue here: it does say.
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ version: 1.5, sessions: [] }), 'utf8')

    await expect(createJsonSessionStore(path).list('p')).rejects.toThrow(/version 1\.5/)
  })

  it('does not report a non-numeric version as if it were one', async () => {
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ version: {}, sessions: [] }), 'utf8')

    const thrown = await createJsonSessionStore(path)
      .list('p')
      .catch((e: unknown) => e)
    expect(String(thrown)).not.toMatch(/\[object Object\]/)
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
  it('leaves the original alone when the write never starts', async () => {
    // A directory where the temp file belongs makes `writeFile` fail at open,
    // so nothing is written at all. This is the weaker half of the claim —
    // see the mid-write test below for the half ARCHITECTURE.md actually
    // states — but it still discriminates against a direct write to `path`,
    // which would succeed here and leave nothing to reject.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'safe', capturedAt: '2026-09-01T09:00:00.000Z' }))
    const before = await readFile(path, 'utf8')

    await mkdir(`${path}.tmp`, { recursive: true })
    // Asserted by code, not bare: `rejects.toThrow()` with no argument passes
    // on any throw, so a future change that made `read` fail for its own
    // reason would still read as evidence that this path held (KV-13 review).
    await expect(store.append(session({ id: 'doomed' }))).rejects.toThrow(
      /EISDIR|EPERM|EACCES/,
    )

    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await createJsonSessionStore(path).list('test-person')).map((s) => s.id)).toEqual([
      'safe',
    ])
  })

  it('does not truncate the history when the write succeeds and the rename fails', async () => {
    // The claim ARCHITECTURE.md actually makes: a crash *mid-write* cannot
    // truncate the history, i.e. a partially written temp file is never
    // renamed over the original. The test above proves only that a write
    // which never began changed nothing, which a plain `writeFile` behind an
    // early throw would also satisfy (KV-13 review).
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'safe', capturedAt: '2026-09-01T09:00:00.000Z' }))
    const before = await readFile(path, 'utf8')

    // Let the temp file be written in full, then lose the rename — the crash
    // window the two-step exists to close.
    renameControl.failNext = true
    await expect(store.append(session({ id: 'doomed' }))).rejects.toThrow(/rename failed/)

    expect(await readFile(path, 'utf8')).toBe(before)
    // And the leftover temp file does not poison the next successful append:
    // it is overwritten, never read.
    await store.append(session({ id: 'next', capturedAt: '2026-09-02T09:00:00.000Z' }))
    expect((await createJsonSessionStore(path).list('test-person')).map((s) => s.id)).toEqual([
      'safe',
      'next',
    ])
  })

  it('keeps the version field across an append', async () => {
    // `write` serialises whatever `read` returned, so the field KV-13 makes
    // meaningful travels through a read-modify-write rather than being
    // rewritten from the constant. A file that lost it on every save would
    // refuse itself on the next read.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'one', capturedAt: '2026-09-01T09:00:00.000Z' }))
    await store.append(session({ id: 'two', capturedAt: '2026-09-02T09:00:00.000Z' }))

    const onDisk: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(onDisk).toMatchObject({ version: 1 })
    expect((await store.list('test-person')).map((s) => s.id)).toEqual(['one', 'two'])
  })

  it('creates the directory it is pointed at', async () => {
    // Electron hands this a path under userData that may not exist yet.
    // `dirname`, not `join(path, '..')`: the latter normalises lexically and
    // works, but it steps up through a *file* segment, which reads as though
    // sessions.json were a directory (KV-13 review).
    const { path } = await storeIn()
    const nested = join(dirname(path), 'deeper', 'sessions.json')
    const store = createJsonSessionStore(nested)

    await store.append(session({ id: 'one' }))
    expect((await store.list('test-person')).map((s) => s.id)).toEqual(['one'])
  })
})

describe('a history file that exists but cannot be opened (KV-95 review)', () => {
  it('is tagged and says so, instead of passing the filesystem error through raw', async () => {
    // A directory where the file should be: reading it fails with EISDIR on
    // every platform, which stands in for a lock or a permission refusal —
    // anything other than "missing", which is a first run.
    const { path } = await storeIn()
    await mkdir(path)
    const thrown = await createJsonSessionStore(path).list('p1').catch((e: unknown) => e)

    expect(thrown).toBeInstanceOf(UnreachableStoreError)
    expect(String(thrown)).toMatch(/could not be opened \(EISDIR\)/)
    expect(String(thrown)).toMatch(/Nothing has been changed/)
    expect(classifyDashboardError(thrown)).toBe('store-unreachable')
    // It can clear by itself, so the questions screen keeps its "worth another
    // go" sentence rather than the unreadable file's "needs looking at".
    expect(classifySubmitError(thrown)).toBe('unknown')
  })

  it('still treats a missing file as a first run', async () => {
    const { path } = await storeIn()
    await expect(createJsonSessionStore(path).list('p1')).resolves.toEqual([])
  })
})

describe('starting a new history when the old one cannot be read (KV-98)', () => {
  const ON = new Date('2026-09-22T10:00:00.000Z')
  const BROKEN = '{ "version": 1, "sessions": [ not json'

  it('sets the unreadable file aside with its bytes intact, and starts an empty history', async () => {
    const { path } = await storeIn()
    await writeFile(path, BROKEN, 'utf8')
    const store = createJsonSessionStore(path, () => ON)

    const aside = await store.startNewHistory()

    expect(aside).toBe(`${path}.unreadable-2026-09-22`)
    expect(await readFile(aside!, 'utf8')).toBe(BROKEN)
    await expect(store.list('test-person')).resolves.toEqual([])
    await store.append(session({ id: 'first' }))
    expect((await store.list('test-person')).map((s) => s.id)).toEqual(['first'])
  })

  it('never moves a history it can read', async () => {
    // The dashboard showed the error a while ago; since then the file was
    // fixed or restored. Moving it now would hide real history.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path, () => ON)
    await store.append(session({ id: 'kept' }))
    const before = await readFile(path, 'utf8')

    await expect(store.startNewHistory()).resolves.toBeNull()
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('has nothing to set aside when there is no file', async () => {
    const { path } = await storeIn()
    await expect(createJsonSessionStore(path, () => ON).startNewHistory()).resolves.toBeNull()
  })

  it('never overwrites an earlier file set aside the same day', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path, () => ON)
    await writeFile(path, 'first bad file', 'utf8')
    const one = await store.startNewHistory()
    await writeFile(path, 'second bad file', 'utf8')
    const two = await store.startNewHistory()

    expect(two).toBe(`${path}.unreadable-2026-09-22-2`)
    expect(await readFile(one!, 'utf8')).toBe('first bad file')
    expect(await readFile(two!, 'utf8')).toBe('second bad file')
  })

  it('leaves a file it cannot open where it is, and says why', async () => {
    const { path } = await storeIn()
    await mkdir(path)
    const thrown = await createJsonSessionStore(path, () => ON)
      .startNewHistory()
      .catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(UnreachableStoreError)
    await expect(readFile(`${path}.unreadable-2026-09-22`)).rejects.toThrow()
  })

  it('no longer tells the caregiver to move the file themselves', async () => {
    const { path } = await storeIn()
    await writeFile(path, BROKEN, 'utf8')
    const thrown = await createJsonSessionStore(path).list('p1').catch((e: unknown) => e)
    expect(String(thrown)).toMatch(/Nothing has been changed\.$/)
    expect(String(thrown)).not.toMatch(/move the file/i)
  })
})

describe('what starting a new history will not do (KV-98 review)', () => {
  const ON = new Date(2026, 8, 22, 10, 0)

  it('never sets aside a history written by a newer version of the app', async () => {
    // A whole history, not a broken one. Setting it aside would strand it: the
    // newer version, installed again, would find no file and start from nothing.
    const { path } = await storeIn()
    const newer = JSON.stringify({ version: 2, sessions: [] })
    await writeFile(path, newer, 'utf8')
    const store = createJsonSessionStore(path, () => ON)

    const listed = await store.list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(NewerStoreError)
    expect(String(listed)).toMatch(/written by a newer version of Kinvue \(file version 2/)
    expect(classifyDashboardError(listed)).toBe('store-newer')
    expect(classifySubmitError(listed)).toBe('store-unreadable')

    await expect(store.startNewHistory()).rejects.toBeInstanceOf(NewerStoreError)
    expect(await readFile(path, 'utf8')).toBe(newer)
  })

  it('still sets aside a file whose version is broken rather than newer', async () => {
    const { path } = await storeIn()
    await writeFile(path, JSON.stringify({ version: 'one', sessions: [] }), 'utf8')
    await expect(createJsonSessionStore(path, () => ON).startNewHistory()).resolves.toMatch(
      /\.unreadable-2026-09-22$/,
    )
  })

  it('never overwrites a file already using the name, even one it did not put there', async () => {
    const { path } = await storeIn()
    await writeFile(`${path}.unreadable-2026-09-22`, 'someone else', 'utf8')
    await writeFile(path, 'broken', 'utf8')

    const aside = await createJsonSessionStore(path, () => ON).startNewHistory()

    expect(aside).toBe(`${path}.unreadable-2026-09-22-2`)
    expect(await readFile(`${path}.unreadable-2026-09-22`, 'utf8')).toBe('someone else')
  })

  it('gives up with a sentence, not a hang, when every name for the day is taken', async () => {
    const { path } = await storeIn()
    await writeFile(`${path}.unreadable-2026-09-22`, 'x', 'utf8')
    for (let n = 2; n <= 100; n++) await writeFile(`${path}.unreadable-2026-09-22-${String(n)}`, 'x', 'utf8')
    await writeFile(path, 'broken', 'utf8')

    await expect(createJsonSessionStore(path, () => ON).startNewHistory()).rejects.toThrow(
      /could not be set aside.*Nothing has been changed/,
    )
    expect(await readFile(path, 'utf8')).toBe('broken')
  })

  it('names the file for the local day, not the UTC one', async () => {
    // 23:30 local on the 23rd is the 24th somewhere west of here in UTC terms;
    // the person pressing the button is on the 23rd.
    const { path } = await storeIn()
    await writeFile(path, 'broken', 'utf8')
    const late = new Date(2026, 8, 23, 23, 30)
    await expect(createJsonSessionStore(path, () => late).startNewHistory()).resolves.toMatch(
      /\.unreadable-2026-09-23$/,
    )
  })

  it('leaves a note beside the set-aside files, once, that survives the notice on screen', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path, () => ON)
    await writeFile(path, 'broken', 'utf8')
    await store.startNewHistory()
    const note = `${path}.unreadable-README.txt`
    expect(await readFile(note, 'utf8')).toMatch(/Kinvue could not\sread/)

    await writeFile(note, 'edited by someone', 'utf8')
    await writeFile(path, 'broken again', 'utf8')
    await store.startNewHistory()
    expect(await readFile(note, 'utf8')).toBe('edited by someone')
  })
})
