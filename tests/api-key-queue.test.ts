import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiKeyStore, type KeyCipher } from '../app/main/api-key'

/**
 * The key store's writes, one at a time (KV-19). Its own file, because it
 * slows the first write the store makes: without the queue, that slow write's
 * rename lands after a later key's, and the older key wins. A real race needs
 * real timing to show; this makes it certain.
 */

const slow = { first: true }
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (slow.first && String(args[0]).endsWith('api-key.json.tmp')) {
        slow.first = false
        await new Promise((r) => setTimeout(r, 60))
      }
      return real.writeFile(...args)
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
})
