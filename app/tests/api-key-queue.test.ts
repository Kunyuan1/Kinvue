import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createApiKeyStore, type KeyCipher } from '../main/api-key'

/**
 * The key store's writes, one at a time (KV-19). Its own file, because it
 * slows the first write the store makes: without the queue, that slow write's
 * rename lands after a later key's, and the older key wins. A real race needs
 * real timing to show; this makes it certain.
 */

const slow = vi.hoisted(() => ({ first: true }))
/** What reached the disk, in order (KV-223): each flush and each rename, by file name. */
const disk = vi.hoisted(() => ({ events: [] as string[] }))
/** Each mode asked for (KV-257), by file name and mode in octal, on any platform. */
const modes = vi.hoisted(() => ({ asked: [] as string[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      if (slow.first && String(args[0]).endsWith('api-key.json.tmp')) {
        slow.first = false
        await new Promise((r) => setTimeout(r, 60))
      }
      const file = await real.open(...args)
      const chmod = file.chmod.bind(file)
      file.chmod = async (mode: string | number): Promise<void> => {
        await chmod(mode)
        modes.asked.push(`${basename(String(args[0]))} ${Number(mode).toString(8)}`)
        disk.events.push(`chmod ${basename(String(args[0]))}`)
      }
      const sync = file.sync.bind(file)
      file.sync = async (): Promise<void> => {
        await sync()
        disk.events.push(`sync ${basename(String(args[0]))}`)
      }
      return file
    },
    rename: async (from: string, to: string): Promise<void> => {
      await real.rename(from, to)
      disk.events.push(`rename ${basename(from)}`)
    },
    chmod: async (...args: Parameters<typeof real.chmod>): Promise<void> => {
      await real.chmod(...args)
      modes.asked.push(`${basename(String(args[0]))} ${Number(args[1]).toString(8)}`)
    },
  }
})

const cipher = (state: { landed: boolean }): KeyCipher => ({
  holdsKey: true,
  get encrypts() {
    return state.landed
  },
  available: () => true,
  lockedLooksLikeForeign: false,
  seal: (text) => Buffer.from(`k:${text}`).toString('base64'),
  open: (sealed) => Buffer.from(sealed, 'base64').toString().slice(2),
})

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  // Each test's own, never an earlier test's (review of #258).
  modes.asked.length = 0
})

describe('the key store writes one at a time', () => {
  it('keeps the key typed last, though the seal of the one before it was slower', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-keyq-'))
    dirs.push(dir)
    const path = join(dir, 'api-key.json')
    const state = { landed: false }
    const store = createApiKeyStore(path, cipher(state))
    await store.load()
    await store.set('ss-live-first-key-0000')
    state.landed = true
    // The seal loop seals the held key (slowly); the dashboard replaces it.
    await Promise.all([store.settle(), store.set('ss-live-second-key-0000')])
    const next = createApiKeyStore(path, cipher({ landed: true }))
    await next.load()
    expect(next.current()).toBe('ss-live-second-key-0000')
  })

  it('flushes the key file to the disk before renaming it into place (KV-223)', async () => {
    // Without the flush a power cut just after a save can leave the key file empty.
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-keyq-'))
    dirs.push(dir)
    const store = createApiKeyStore(join(dir, 'api-key.json'), cipher({ landed: true }))
    await store.load()
    disk.events.length = 0
    await store.set('ss-live-flushed-key-0000')
    // Then the folder, where it can be flushed; Windows has no such flush.
    const folder = process.platform === 'win32' ? [] : [`sync ${basename(dir)}`]
    expect(disk.events).toEqual([
      'chmod api-key.json.tmp',
      'sync api-key.json.tmp',
      'rename api-key.json.tmp',
      ...folder,
    ])
  })

  it('leaves no copy of the key behind when a save fails (review of #247)', async () => {
    // A temporary file left by a refused save holds the key, unencrypted where there is no
    // key store, under a name `forget` never removes. Here the rename fails: the file's
    // place is taken by a folder.
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-keyq-'))
    dirs.push(dir)
    const store = createApiKeyStore(join(dir, 'api-key.json'), cipher({ landed: true }))
    await store.load()
    await mkdir(join(dir, 'api-key.json'))
    await expect(store.set('ss-live-refused-key-0000')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['api-key.json'])
  })
})

describe('who may read the key file (KV-257)', () => {
  it('removes a temporary file a crash left as it loads (review of #258)', async () => {
    // Where there is no key store, the key is in it in plain text.
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-keymode-'))
    dirs.push(dir)
    const path = join(dir, 'api-key.json')
    await writeFile(`${path}.tmp`, '{"key":"ss-live-left-by-a-crash"}')
    await createApiKeyStore(path, cipher({ landed: true })).load()
    await expect(stat(`${path}.tmp`)).rejects.toThrow()
  })

  it('writes it for its own user only, and brings one from before to that as it loads', async () => {
    // Where there is no key store, the key is in it in plain text.
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-keymode-'))
    dirs.push(dir)
    const path = join(dir, 'api-key.json')
    const store = createApiKeyStore(path, cipher({ landed: true }))
    await store.load()
    await store.set('ss-live-private-key-0000')
    expect(modes.asked).toContain('api-key.json.tmp 600')

    modes.asked.length = 0
    await createApiKeyStore(path, cipher({ landed: true })).load()
    expect(modes.asked).toContain('api-key.json 600')
  })

  it.skipIf(process.platform === 'win32')('leaves the file readable by its own user only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-keymode-'))
    dirs.push(dir)
    const path = join(dir, 'api-key.json')
    const store = createApiKeyStore(path, cipher({ landed: true }))
    await store.load()
    await store.set('ss-live-private-key-0000')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await chmod(path, 0o644)
    await createApiKeyStore(path, cipher({ landed: true })).load()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
