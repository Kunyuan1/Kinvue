import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkKey, createApiKeyStore, type KeyCipher } from '../app/main/api-key'

/**
 * The household's own SmartSpectra key (KV-19, T15), with a stand-in for the
 * operating system's cipher whose readiness the test controls: whether it
 * holds a key at all, whether that key is on disk yet, whether it can be
 * reached now.
 */

const KEY = 'ss-live-0123456789abcdef'

function cipher(name: string, state: { holds?: boolean; landed?: boolean; reachable?: boolean } = {}) {
  const s = { holds: true, landed: true, reachable: true, ...state }
  const c: KeyCipher & { s: typeof s } = {
    s,
    get holdsKey() {
      return s.holds
    },
    get encrypts() {
      return s.holds && s.landed
    },
    available: () => s.reachable,
    lockedLooksLikeForeign: false,
    seal: (text) => Buffer.from(`${name}:${text}`).toString('base64'),
    open: (sealed) => {
      const text = Buffer.from(sealed, 'base64').toString()
      if (!text.startsWith(`${name}:`)) throw new Error('not this key')
      return text.slice(name.length + 1)
    },
  }
  return c
}

const dirs: string[] = []
async function keyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kinvue-key-'))
  dirs.push(dir)
  return join(dir, 'api-key.json')
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('checkKey', () => {
  it('trims a pasted key, and refuses what cannot be one', () => {
    expect(checkKey(`  ${KEY}\n`)).toBe(KEY)
    for (const typed of ['', 'short', 'two words here', `key: ${KEY}`, 'x'.repeat(513), 'tab\tkey123']) {
      expect(checkKey(typed), JSON.stringify(typed)).toBeNull()
    }
  })
})

describe('the key, kept (KV-19)', () => {
  it('starts with none, and keeps a key sealed, never in the clear', async () => {
    const path = await keyPath()
    const store = createApiKeyStore(path, cipher('mine'))
    await store.load()
    expect(store.status()).toBe('none')
    expect(store.current()).toBeNull()
    expect(await store.set(KEY)).toBe('saved')
    expect(store.current()).toBe(KEY)
    expect(await readFile(path, 'utf8')).not.toContain(KEY)

    const again = createApiKeyStore(path, cipher('mine'))
    await again.load()
    expect(again.status()).toBe('saved')
    expect(again.current()).toBe(KEY)
  })

  it('refuses what cannot be a key, and writes nothing', async () => {
    const path = await keyPath()
    const store = createApiKeyStore(path, cipher('mine'))
    await store.load()
    await expect(store.set('not a key')).rejects.toThrow(/not a SmartSpectra key/)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
    expect(store.status()).toBe('none')
  })
})

describe('never sealed before the operating system key is on disk (review of #192)', () => {
  it('holds a key typed in the gap in memory only, usable, and seals it once the key lands', async () => {
    const path = await keyPath()
    const c = cipher('mine', { landed: false })
    const store = createApiKeyStore(path, c)
    await store.load()
    expect(await store.set(KEY)).toBe('held')
    expect(store.current()).toBe(KEY)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
    expect(await store.settle()).toBe(false)

    c.s.landed = true
    expect(await store.settle()).toBe(true)
    expect(store.status()).toBe('saved')
    expect(await readFile(path, 'utf8')).not.toContain(KEY)
  })

  it('asks again after a close inside the gap: nothing was written', async () => {
    const path = await keyPath()
    const store = createApiKeyStore(path, cipher('mine', { landed: false }))
    await store.load()
    await store.set(KEY)
    const next = createApiKeyStore(path, cipher('mine'))
    await next.load()
    expect(next.status()).toBe('none')
  })

  it('seals a replacement over a sealed file, though the key reads as not yet landed', async () => {
    // The ratchet the history has (review of #187): a sealed file is never
    // written plain, and a key that sealed it is a key on disk.
    const path = await keyPath()
    await (async () => {
      const s = createApiKeyStore(path, cipher('mine'))
      await s.load()
      await s.set(KEY)
    })()
    const store = createApiKeyStore(path, cipher('mine', { landed: false }))
    await store.load()
    expect(await store.set('ss-live-replacement-key')).toBe('saved')
    expect(await readFile(path, 'utf8')).not.toContain('replacement')
  })
})

describe('writes, one at a time', () => {
  it('lets a key typed while the seal loop settles land whole, and the last one win', async () => {
    const path = await keyPath()
    const c = cipher('mine', { landed: false })
    const store = createApiKeyStore(path, c)
    await store.load()
    await store.set(KEY)
    c.s.landed = true
    // The seal loop and a replacement from the dashboard, together.
    await Promise.all([store.settle(), store.set('ss-live-replacement-0000'), store.settle()])
    const next = createApiKeyStore(path, cipher('mine'))
    await next.load()
    expect(next.status()).toBe('saved')
    expect(next.current()).toBe('ss-live-replacement-0000')
  })
})

describe('where there is no key store', () => {
  it('keeps the key unencrypted, says so, and seals it if a key store appears', async () => {
    const path = await keyPath()
    const c = cipher('mine', { holds: false })
    const store = createApiKeyStore(path, c)
    await store.load()
    expect(await store.set(KEY)).toBe('saved-plain')
    expect(await readFile(path, 'utf8')).toContain(KEY)

    const later = cipher('mine')
    const next = createApiKeyStore(path, later)
    await next.load()
    expect(next.status()).toBe('saved-plain')
    expect(await next.settle()).toBe(true)
    expect(next.status()).toBe('saved')
    expect(await readFile(path, 'utf8')).not.toContain(KEY)
  })
})

describe("a key file that will not open: KV-175's two cases (review of #192)", () => {
  async function sealedBy(name: string): Promise<string> {
    const path = await keyPath()
    const s = createApiKeyStore(path, cipher(name))
    await s.load()
    await s.set(KEY)
    return path
  }

  it('keeps the file when the key store is out of reach, and will not replace it unseen', async () => {
    const path = await sealedBy('mine')
    const before = await readFile(path, 'utf8')
    const store = createApiKeyStore(path, cipher('mine', { reachable: false }))
    await store.load()
    expect(store.status()).toBe('locked')
    expect(store.current()).toBeNull()
    await expect(store.set('ss-live-another-key-0000')).rejects.toThrow(/not available/)
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('asks again when the key store answered and still would not open it', async () => {
    const path = await sealedBy('another account')
    const store = createApiKeyStore(path, cipher('mine'))
    await store.load()
    expect(store.status()).toBe('lost')
    expect(store.current()).toBeNull()
    expect(await store.set(KEY)).toBe('saved')
    const next = createApiKeyStore(path, cipher('mine'))
    await next.load()
    expect(next.current()).toBe(KEY)
  })

  it('asks again for a file that is not a key file at all', async () => {
    for (const text of ['{ not json', '{"version":2,"sealed":"x"}', '{"version":1}', '{"version":1,"plain":"x"}']) {
      const path = await keyPath()
      await writeFile(path, text, 'utf8')
      const store = createApiKeyStore(path, cipher('mine'))
      await store.load()
      expect(store.status(), text).toBe('lost')
    }
  })
})
