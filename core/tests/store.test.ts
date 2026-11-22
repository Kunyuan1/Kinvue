import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  createJsonSessionStore,
  NewerStoreError,
  UnreachableStoreError,
  UnreadableStoreError,
  UnrecognisedRecordError,
} from '@kinvue/core/session/store'
import { classifyDashboardError, classifySubmitError } from '@kinvue/core/capture/failure'
import { DEMO_PERSON_ID } from '@kinvue/core/session/people'
import type { SessionRecord } from '@kinvue/core/session/types'
import { session, sessionBeforeKV16 } from './helpers'

/**
 * A rename that can be made to fail once.
 *
 * `store.ts` does `import { rename } from 'node:fs/promises'`, so the binding
 * is resolved at import time and `vi.spyOn` on the namespace cannot reach it —
 * the module object is frozen. Everything else delegates to the real fs, so
 * the rest of the suite is untouched.
 */
const renameControl = vi.hoisted(() => ({ failNext: false }))

/**
 * What reached the disk, in order (KV-223): each flush, each rename and each
 * removal, by the file's name. And a flush that can be made to fail once.
 */
const disk = vi.hoisted(() => ({ events: [] as string[], failNextSync: false }))

/**
 * Each mode asked for (KV-257), by the file's name and the mode in octal: on an open file,
 * by name, or as a new file is written. Recorded on every platform, though only POSIX
 * honours them, so what is asked for is pinned here and what a mode does is pinned by the
 * POSIX-only tests beside these.
 */
const modes = vi.hoisted(() => ({ asked: [] as string[], refuse: false, refuseOpen: '' }))

/**
 * The flush of the folder `path` is in, as `replaceFile` asks for it after its
 * rename: everywhere but Windows, which has none to ask for.
 */
const folderFlush = (path: string): string[] =>
  process.platform === 'win32' ? [] : [`sync ${basename(dirname(path))}`]

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args)
      const chmod = file.chmod.bind(file)
      file.chmod = async (mode: string | number): Promise<void> => {
        // A file system that keeps no modes: FAT on Linux, under its default mount.
        if (modes.refuseOpen !== '') {
          throw Object.assign(new Error(`${modes.refuseOpen}: chmod`), { code: modes.refuseOpen })
        }
        await chmod(mode)
        modes.asked.push(`${basename(String(args[0]))} ${Number(mode).toString(8)}`)
        // In the order of the disk's events too, so a test can say it came first.
        disk.events.push(`chmod ${basename(String(args[0]))}`)
      }
      const sync = file.sync.bind(file)
      file.sync = async (): Promise<void> => {
        if (disk.failNextSync) {
          disk.failNextSync = false
          throw new Error('EIO: sync failed')
        }
        await sync()
        disk.events.push(`sync ${basename(String(args[0]))}`)
      }
      return file
    },
    rename: async (from: string, to: string): Promise<void> => {
      if (renameControl.failNext) {
        renameControl.failNext = false
        throw new Error('EIO: rename failed')
      }
      await actual.rename(from, to)
      disk.events.push(`rename ${basename(from)}`)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>): Promise<void> => {
      await actual.unlink(...args)
      disk.events.push(`unlink ${basename(String(args[0]))}`)
    },
    chmod: async (...args: Parameters<typeof actual.chmod>): Promise<void> => {
      // As on a file this user can read but does not own.
      if (modes.refuse) throw Object.assign(new Error('EPERM: chmod'), { code: 'EPERM' })
      await actual.chmod(...args)
      modes.asked.push(`${basename(String(args[0]))} ${Number(args[1]).toString(8)}`)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
      await actual.writeFile(...args)
      const options = args[2]
      if (typeof options === 'object' && options !== null && options.mode !== undefined) {
        modes.asked.push(`${basename(String(args[0]))} ${Number(options.mode).toString(8)} new`)
      }
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
  // Each test's own, never an earlier test's (review of #258).
  modes.asked.length = 0
  modes.refuse = false
  modes.refuseOpen = ''
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

    expect((await store.people()).map((p) => p.id)).toEqual(['test-person', 'other-person'])
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

  it('lists a seeded day from before KV-16 by the question asked now, and writes nothing back (review of #167)', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    const seededOld = sessionBeforeKV16(false, { id: 'seeded', seeded: true, capturedAt: '2026-09-01T09:00:00.000Z' })
    const realOld = sessionBeforeKV16(false, { id: 'real', capturedAt: '2026-09-02T09:00:00.000Z' })
    await store.append(seededOld)
    await store.append(realOld)
    // An append after the list, which rewrites the whole file. The seeded day is
    // the demo's, whoever it was written under (KV-18), and listed as the demo's.
    const [seeded] = await store.list(DEMO_PERSON_ID)
    const [real, ...more] = await store.list('test-person')
    expect(more).toEqual([])
    await store.append(session({ id: 'new', capturedAt: '2026-09-03T09:00:00.000Z' }))

    expect(seeded?.personId).toBe(DEMO_PERSON_ID)
    // Generated data, read as a fresh seed would have written it.
    expect(seeded?.answers).toEqual({ ...seededOld.answers, eatenToday: undefined, skippedMeal: true })
    expect(seeded?.answers).not.toHaveProperty('eatenToday')
    // A real person's answer keeps the question they were asked.
    expect(real).toEqual(realOld)
    // And on disk, both exactly as written.
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { sessions: unknown[] }
    expect(onDisk.sessions.slice(0, 2)).toEqual([seededOld, realOld])
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
    await writeFile(path, JSON.stringify({ version: 4, records: [] }), 'utf8')

    const thrown = await createJsonSessionStore(path)
      .list('p')
      .catch((e: unknown) => e)
    expect(String(thrown)).toMatch(/version 4/)
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
    // The temp file goes with the write that failed (review of #247): it holds
    // the whole history under a name nothing else reads or removes.
    expect(await readdir(dirname(path))).toEqual(['sessions.json'])
    // And the next append goes through.
    await store.append(session({ id: 'next', capturedAt: '2026-09-02T09:00:00.000Z' }))
    expect((await createJsonSessionStore(path).list('test-person')).map((s) => s.id)).toEqual([
      'safe',
      'next',
    ])
  })

  it('flushes the temporary file to the disk before it is renamed into place (KV-223)', async () => {
    // A rename can reach the disk before the text it names. Without the flush
    // a power cut just after a write leaves `sessions.json` empty or zeros:
    // the whole history gone, and an empty file read as a first run.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    disk.events.length = 0
    await store.append(session({ id: 'kept', capturedAt: '2026-09-01T09:00:00.000Z' }))

    // Then the folder, where it can be, so the rename itself is on the disk: a
    // lost one would bring back whatever this write took out (review of #247).
    // Its mode first, before a byte is written (KV-257).
    expect(disk.events).toEqual([
      'chmod sessions.json.tmp',
      'sync sessions.json.tmp',
      'rename sessions.json.tmp',
      ...folderFlush(path),
    ])
  })

  it('renames nothing into place when the flush fails', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'safe', capturedAt: '2026-09-01T09:00:00.000Z' }))
    const before = await readFile(path, 'utf8')

    disk.events.length = 0
    disk.failNextSync = true
    await expect(store.append(session({ id: 'doomed' }))).rejects.toThrow(/sync failed/)

    // Nothing renamed, and the temp file removed, not left (review of #247).
    expect(disk.events).toEqual(['chmod sessions.json.tmp', 'unlink sessions.json.tmp'])
    expect(await readdir(dirname(path))).toEqual(['sessions.json'])
    expect(await readFile(path, 'utf8')).toBe(before)
    // The file is closed, not left held: the next write goes through.
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
    expect(onDisk).toMatchObject({ version: 2 })
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

  it('flushes the copy to the disk before the original is removed (review of #247)', async () => {
    // The copy is the only one there will be. Removed first, or unflushed, a
    // power cut leaves the name of a file set aside and nothing in it.
    const { path } = await storeIn()
    await writeFile(path, BROKEN, 'utf8')
    const store = createJsonSessionStore(path, () => ON)
    disk.events.length = 0

    await store.startNewHistory()

    expect(disk.events).toEqual([
      'chmod sessions.json.unreadable-2026-09-22',
      'sync sessions.json.unreadable-2026-09-22',
      'unlink sessions.json',
    ])
  })

  it('removes nothing when the copy cannot be flushed', async () => {
    const { path } = await storeIn()
    await writeFile(path, BROKEN, 'utf8')
    const store = createJsonSessionStore(path, () => ON)

    disk.failNextSync = true
    await expect(store.startNewHistory()).rejects.toThrow(/sync failed/)

    expect(await readFile(path, 'utf8')).toBe(BROKEN)
    // The next press sets it aside under the next name, as after a removal
    // that failed.
    await expect(store.startNewHistory()).resolves.toBe(`${path}.unreadable-2026-09-22-2`)
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
    const newer = JSON.stringify({ version: 4, sessions: [] })
    await writeFile(path, newer, 'utf8')
    const store = createJsonSessionStore(path, () => ON)

    const listed = await store.list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(NewerStoreError)
    expect(String(listed)).toMatch(/written by a newer version of Kinvue \(file version 4/)
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

describe('records that make sense on their own (KV-30)', () => {
  /** A file as KV-13 writes it, holding these records exactly. */
  const fileOf = (sessions: unknown[]): string => JSON.stringify({ version: 1, sessions })

  it('reads a history from before KV-30 as it is, and never rewrites it to say so', async () => {
    // The migration is the absence of one: a record with no format is format 1.
    const { path } = await storeIn()
    const old = [
      session({ id: 'old-1' }),
      session({ id: 'old-2', capturedAt: '2026-09-16T09:00:00.000Z' }),
    ]
    await writeFile(path, fileOf(old), 'utf8')
    const store = createJsonSessionStore(path)

    expect(await store.list('test-person')).toEqual(old)
    await store.append(session({ id: 'new', format: 1, capturedAt: '2026-09-17T09:00:00.000Z' }))
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      sessions: Record<string, unknown>[]
    }
    expect(written.sessions.slice(0, 2)).toEqual(old)
    expect(written.sessions[0]).not.toHaveProperty('format')
    expect(written.sessions[2]?.format).toBe(1)
  })

  it('refuses a history holding a newer record, whole, and will not set it aside', async () => {
    const { path } = await storeIn()
    const text = fileOf([session({ id: 'old' }), session({ id: 'newer', format: 2 })])
    await writeFile(path, text, 'utf8')
    const store = createJsonSessionStore(path, () => new Date(2026, 8, 22, 10, 0))

    const listed = await store.list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(NewerStoreError)
    expect(String(listed)).toContain(
      'holds check-ins written by a newer version of Kinvue (record format 2; this one reads ' +
        'format 1)',
    )
    expect(classifyDashboardError(listed)).toBe('store-newer')
    await expect(store.append(session({ id: 'today' }))).rejects.toBeInstanceOf(NewerStoreError)
    await expect(store.startNewHistory()).rejects.toBeInstanceOf(NewerStoreError)
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('refuses an entry it cannot read, says which, and never sets the history aside', async () => {
    // One bad entry among good ones is not a broken file: offering to archive
    // the baseline over it would be the destructive answer (review of #182).
    const cases: [unknown, string][] = [
      [
        { ...session(), format: '1' },
        'is a check-in this app cannot read (format is not a record format)',
      ],
      [null, 'is not a check-in at all'],
      ['a check-in', 'is not a check-in at all'],
    ]
    for (const [bad, says] of cases) {
      const { path } = await storeIn()
      const text = fileOf([session({ id: 'fine' }), bad, session({ id: 'also-fine' })])
      await writeFile(path, text, 'utf8')
      const store = createJsonSessionStore(path, () => new Date(2026, 9, 3, 10, 0))
      const listed = await store.list('test-person').catch((e: unknown) => e)
      expect(listed, JSON.stringify(bad)).toBeInstanceOf(UnrecognisedRecordError)
      expect(String(listed)).toContain(`Entry 2 of 3 in the check-in history at ${path} ${says}`)
      expect(String(listed)).toContain('the rest of the history is intact')
      expect(classifyDashboardError(listed)).toBe('store-record-unknown')
      expect(classifySubmitError(listed)).toBe('store-unreadable')
      await expect(store.startNewHistory()).rejects.toBeInstanceOf(UnrecognisedRecordError)
      expect(await readFile(path, 'utf8')).toBe(text)
    }
  })

  it('refuses an entry over any field, not just its format, naming the field', async () => {
    const { path } = await storeIn()
    const bad = session({ id: 'bad' }) as unknown as { vitals: Record<string, unknown> }
    bad.vitals.durationSec = '30'
    const text = fileOf([session({ id: 'fine' }), bad])
    await writeFile(path, text, 'utf8')
    const store = createJsonSessionStore(path, () => new Date(2026, 9, 4, 10, 0))

    const listed = await store.list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(UnrecognisedRecordError)
    expect(String(listed)).toContain(
      'Entry 2 of 2 in the check-in history at ' +
        `${path} is a check-in this app cannot read (vitals.durationSec is not a number)`,
    )
    expect(classifyDashboardError(listed)).toBe('store-record-unknown')
    await expect(store.append(session({ id: 'today' }))).rejects.toBeInstanceOf(
      UnrecognisedRecordError,
    )
    await expect(store.startNewHistory()).rejects.toBeInstanceOf(UnrecognisedRecordError)
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('stores a record that arrives twice once, and does not write the second time', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    const record = session({ id: 'once', format: 1 })
    await store.append(record)
    const before = await readFile(path, 'utf8')

    renameControl.failNext = true // would throw if a write were attempted
    await store.append(structuredClone(record))
    renameControl.failNext = false
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await store.list('test-person')).toEqual([record])
  })

  it('takes a record from before KV-30, arriving again as format 1, for the same one', async () => {
    const { path } = await storeIn()
    await writeFile(path, fileOf([session({ id: 'old' })]), 'utf8')
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'old', format: 1 }))
    expect(await store.list('test-person')).toHaveLength(1)
  })

  it('refuses a different record under an id already stored, and changes nothing', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'taken' }))
    const before = await readFile(path, 'utf8')

    const clash = store.append(session({ id: 'taken', vitals: { pulseRateBpm: 95 } }))
    await expect(clash).rejects.toThrow(/already holds a different check-in with the id taken/)
    await expect(clash).rejects.toThrow(/Nothing has been changed/)
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('exporting, restoring and deleting (KV-21)', () => {
  const AT = new Date('2026-10-05T12:00:00.000Z')
  const day = (n: number): string => new Date(Date.UTC(2026, 8, 1 + n, 9)).toISOString()
  const fileOf = (data: unknown): string => JSON.stringify(data)
  type OnDisk = { sessions: SessionRecord[]; removed?: unknown[]; lastExported?: unknown }
  const onDisk = async (path: string): Promise<OnDisk> =>
    JSON.parse(await readFile(path, 'utf8')) as OnDisk

  it('deletes in one write, with a tombstone per real check-in, none for demo', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'a', capturedAt: day(0) }))
    await store.append(session({ id: 'b', capturedAt: day(1) }))
    await store.append(session({ id: 'seed-x', capturedAt: day(2), seeded: true }))

    // The seeded day is the demo's (KV-18): the person's deletion leaves it,
    // and the demo's takes it, with no tombstone.
    expect(await store.remove('test-person', { kind: 'all' }, AT)).toBe(2)
    expect(await store.remove(DEMO_PERSON_ID, { kind: 'all' }, AT)).toBe(1)
    expect(await onDisk(path)).toMatchObject({
      sessions: [],
      removed: [
        { id: 'a', personId: 'test-person', removedAt: AT.toISOString() },
        { id: 'b', personId: 'test-person', removedAt: AT.toISOString() },
      ],
    })
  })

  it('writes nothing for a deletion naming nothing, adding no list to a file', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'a' }))
    const before = await readFile(path, 'utf8')
    expect(await store.remove('test-person', { kind: 'one', id: 'nope' }, AT)).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await onDisk(path)).not.toHaveProperty('removed')
  })

  it('adds no deletion list to the file when what it deleted were demo days', async () => {
    // Demo days leave no tombstones, so there is nothing to list — and a file
    // nothing real was deleted from is written as it always was.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'seed-x', seeded: true }))
    expect(await store.remove(DEMO_PERSON_ID, { kind: 'all' }, AT)).toBe(1)
    // Nobody on the list, either: a seeded day adds no person (KV-18).
    expect(await onDisk(path)).toEqual({ version: 2, sessions: [], people: [] })
  })

  it('keeps a deleted check-in deleted when it arrives again, and writes nothing', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    const record = session({ id: 'a' })
    await store.append(record)
    await store.remove('test-person', { kind: 'one', id: 'a' }, AT)
    const before = await readFile(path, 'utf8')
    await store.append(record)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await store.list('test-person')).toEqual([])
  })

  it('refuses a deletion record it cannot read, naming it, never setting it aside', async () => {
    const { path } = await storeIn()
    const text = fileOf({
      version: 1,
      sessions: [session({ id: 'a' })],
      removed: [{ id: 'gone', personId: 'test-person', removedAt: 'yesterday' }],
    })
    await writeFile(path, text, 'utf8')
    const store = createJsonSessionStore(path, () => new Date(2026, 9, 5, 10, 0))
    const listed = await store.list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(UnrecognisedRecordError)
    expect(String(listed)).toContain(
      `Deletion record 1 of 1 in the check-in history at ${path} cannot be read ` +
        '(removedAt is not a time)',
    )
    expect(classifyDashboardError(listed)).toBe('store-record-unknown')
    await expect(store.startNewHistory()).rejects.toBeInstanceOf(UnrecognisedRecordError)
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('names the list, not an entry it lacks, when the deletions are not a list', async () => {
    const { path } = await storeIn()
    await writeFile(path, fileOf({ version: 1, sessions: [], removed: {} }), 'utf8')
    const listed = await createJsonSessionStore(path).list('test-person').catch((e: unknown) => e)
    expect(listed).toBeInstanceOf(UnrecognisedRecordError)
    expect(String(listed)).toContain(
      `The list of deleted check-ins in the check-in history at ${path} cannot be read ` +
        '(it is not a list)',
    )
    expect(String(listed)).not.toMatch(/record 1 of 1/)
  })

  it('restores an export into another store exactly, and again changes nothing', async () => {
    const from = createJsonSessionStore((await storeIn()).path)
    await from.append(session({ id: 'a', capturedAt: day(0) }))
    await from.append(session({ id: 'b', capturedAt: day(1), timeZone: 'Europe/London' }))
    await from.remove('test-person', { kind: 'one', id: 'a' }, AT)
    const exported = JSON.parse(JSON.stringify(await from.exportFor('test-person', AT))) as unknown

    const { path } = await storeIn()
    const to = createJsonSessionStore(path)
    const plan = await to.restore(exported)
    expect(plan.ok && plan.outcome).toMatchObject({ restored: 1 })
    expect(await to.list('test-person')).toEqual(await from.list('test-person'))
    expect((await onDisk(path)).removed).toEqual([
      { id: 'a', personId: 'test-person', removedAt: AT.toISOString() },
    ])

    const after = await readFile(path, 'utf8')
    const again = await to.restore(exported)
    expect(again.ok && again.outcome).toMatchObject({ restored: 0, alreadyHere: 1 })
    expect(await readFile(path, 'utf8')).toBe(after)
  })

  it('writes nothing for a file it refuses', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'a' }))
    const before = await readFile(path, 'utf8')
    const plan = await store.restore({ kind: 'kinvue-history', version: 3 })
    expect(plan).toEqual({ ok: false, refusal: { kind: 'newer', of: 'export', version: 3 } })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('exports without writing, and remembers when it last did once told', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'a' }))
    const before = await readFile(path, 'utf8')
    await store.exportFor('test-person', AT)
    expect(await readFile(path, 'utf8')).toBe(before)

    expect(await store.lastExported('test-person')).toBeNull()
    await store.markExported('test-person', AT)
    expect(await store.lastExported('test-person')).toBe(AT.toISOString())
    expect(await store.lastExported('another-person')).toBeNull()
  })

  it('replaces a last-export record that is not one, rather than writing junk back', async () => {
    const { path } = await storeIn()
    await writeFile(path, fileOf({ version: 1, sessions: [], lastExported: '2026-10-01' }), 'utf8')
    await createJsonSessionStore(path).markExported('test-person', AT)
    expect((await onDisk(path)).lastExported).toEqual({ 'test-person': AT.toISOString() })
  })

  it('reads a last-export date it cannot read as never, not as a refusal', async () => {
    const { path } = await storeIn()
    await writeFile(
      path,
      fileOf({ version: 1, sessions: [session({ id: 'a' })], lastExported: { 'test-person': 5 } }),
      'utf8',
    )
    const store = createJsonSessionStore(path)
    expect(await store.lastExported('test-person')).toBeNull()
    expect(await store.list('test-person')).toHaveLength(1)
  })
})

describe('a version-1 history whose upgrade cannot be written (KV-18, review of #200)', () => {
  it('is still read, with the same keys every time, and the upgrade saved by the next read that can', async () => {
    const { path } = await storeIn()
    const v1 = { version: 1, sessions: [session({ id: 'one' })] }
    await writeFile(path, JSON.stringify(v1), 'utf8')
    const store = createJsonSessionStore(path)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // The upgrade's write fails — a backup agent holding the file, say — and
    // fails again on the next read: said once, not on every read (second
    // review of #200).
    renameControl.failNext = true
    const first = await store.people()
    expect(first.map((p) => [p.id, p.name])).toEqual([['test-person', null]])
    renameControl.failNext = true
    expect(await store.people()).toEqual(first)
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
    // Nothing saved: the file is the version-1 history it was.
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(v1)

    // The next read writes it, with the keys the first one answered with, and
    // the history reads as it always did.
    expect((await store.list('test-person')).map((s) => s.id)).toEqual(['one'])
    const again = await store.people()
    expect(again).toEqual(first)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...v1, version: 2, people: first })
  })
})

describe('who may read the history (KV-257)', () => {
  it('saves a check-in on a file system that keeps no modes (review of #258)', async () => {
    // A history on a USB stick: FAT keeps no modes, and says EPERM when asked for one.
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP']) {
      modes.refuseOpen = code
      await store.append(session({ id: code, capturedAt: '2026-09-01T09:00:00.000Z' }))
    }
    modes.refuseOpen = ''
    expect((await store.list('test-person')).map((r) => r.id).sort()).toEqual([
      'ENOTSUP',
      'EOPNOTSUPP',
      'EPERM',
    ])
    // Anything else is a failure, and fails the write.
    modes.refuseOpen = 'EIO'
    await expect(store.append(session({ id: 'lost' }))).rejects.toThrow(/EIO/)
  })

  it('sets a history aside on a file system that keeps no modes, once (review of #258)', async () => {
    const { path } = await storeIn()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not json', 'utf8')
    modes.refuseOpen = 'EPERM'
    const aside = await createJsonSessionStore(path, () => new Date('2026-09-22T12:00:00'))
      .startNewHistory()
    modes.refuseOpen = ''
    expect(aside).not.toBeNull()
    // Set aside and gone, not a copy left for each press.
    expect((await readdir(dirname(path))).filter((n) => n.includes('.unreadable-2'))).toEqual([
      basename(aside!),
    ])
    await expect(stat(path)).rejects.toThrow()
  })

  it('removes a temporary file a crash left, on its first read (review of #258)', async () => {
    const { path } = await storeIn()
    await createJsonSessionStore(path).append(session({ id: 'one' }))
    await writeFile(`${path}.tmp`, 'the whole history, as a crash left it')
    await createJsonSessionStore(path).list('test-person')
    await expect(stat(`${path}.tmp`)).rejects.toThrow()
  })

  it('makes the histories set aside before, and their note, its own user\u2019s (review of #258)', async () => {
    // Left by an earlier build, and never read again: only this reaches them.
    const { path } = await storeIn()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.unreadable-2026-09-01`, 'old', 'utf8')
    await writeFile(`${path}.unreadable-README.txt`, 'note', 'utf8')
    await writeFile(join(dirname(path), 'someone-else.txt'), 'not ours', 'utf8')
    await createJsonSessionStore(path).list('test-person')
    expect(modes.asked).toEqual(
      expect.arrayContaining([
        'sessions.json.unreadable-2026-09-01 600',
        'sessions.json.unreadable-README.txt 600',
      ]),
    )
    expect(modes.asked.some((m) => m.startsWith('someone-else.txt'))).toBe(false)
  })

  it('says when it cannot make the history its own user\u2019s, and opens it anyway (review of #258)', async () => {
    const { path } = await storeIn()
    await createJsonSessionStore(path).append(session({ id: 'kept' }))
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    modes.refuse = true
    const listed = await createJsonSessionStore(path).list('test-person')
    modes.refuse = false
    expect(listed.map((r) => r.id)).toEqual(['kept'])
    expect(said).toHaveBeenCalledWith(expect.stringMatching(/^Could not make .*sessions\.json readable by this user only \(EPERM\)/))
    said.mockRestore()
  })

  it('writes the history for its own user only, from before a byte is in it', async () => {
    const { path } = await storeIn()
    const store = createJsonSessionStore(path)
    await store.append(session({ id: 'one', capturedAt: '2026-09-01T09:00:00.000Z' }))
    expect(modes.asked).toContain('sessions.json.tmp 600')
  })

  it('brings a history from before to its own user only on the store\u2019s first read, once', async () => {
    const { path } = await storeIn()
    await createJsonSessionStore(path).append(session({ id: 'one' }))
    modes.asked.length = 0
    const store = createJsonSessionStore(path)
    await store.list('test-person')
    await store.list('test-person')
    expect(modes.asked.filter((m) => m === 'sessions.json 600')).toHaveLength(1)
  })

  it('opens a history it cannot change the mode of, and a missing one, as it always has', async () => {
    const { path } = await storeIn()
    // None yet: the first run, with nothing to make private.
    expect(await createJsonSessionStore(path).list('test-person')).toEqual([])
    await createJsonSessionStore(path).append(session({ id: 'kept' }))
    modes.refuse = true
    try {
      const listed = await createJsonSessionStore(path).list('test-person')
      expect(listed.map((r) => r.id)).toEqual(['kept'])
    } finally {
      modes.refuse = false
    }
  })

  it('sets a history aside, and writes its note, for its own user only', async () => {
    const { path } = await storeIn()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not json', 'utf8')
    modes.asked.length = 0
    const aside = await createJsonSessionStore(path, () => new Date('2026-09-22T12:00:00')).startNewHistory()
    expect(aside).not.toBeNull()
    expect(modes.asked).toContain(`${basename(aside!)} 600`)
    expect(modes.asked).toContain('sessions.json.unreadable-README.txt 600 new')
  })

  it.skipIf(process.platform === 'win32')(
    'leaves every file of the history readable by its own user only',
    async () => {
      const { path } = await storeIn()
      await mkdir(dirname(path), { recursive: true })
      // A history and a temporary file from before, as the umask left them.
      await writeFile(path, '', { mode: 0o644 })
      await chmod(path, 0o644)
      await writeFile(`${path}.tmp`, 'half', { mode: 0o666 })
      await chmod(`${path}.tmp`, 0o666)
      const store = createJsonSessionStore(path)
      await store.list('test-person')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      await store.append(session({ id: 'one' }))
      expect((await stat(path)).mode & 0o777).toBe(0o600)

      await writeFile(path, 'not json', { mode: 0o644 })
      await chmod(path, 0o644)
      const aside = await createJsonSessionStore(path).startNewHistory()
      expect((await stat(aside!)).mode & 0o777).toBe(0o600)
      expect((await stat(`${path}.unreadable-README.txt`)).mode & 0o777).toBe(0o600)
    },
  )
})
