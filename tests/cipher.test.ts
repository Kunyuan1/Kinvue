import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  holdsAKey,
  localStateHoldsKey,
  osCipher,
  protectionOf,
  reachable,
  type SafeStorageLike,
} from '../app/main/cipher'
import {
  createJsonSessionStore,
  LockedStoreError,
  UndecryptableStoreError,
} from '@core/session/store'
import { classifyDashboardError } from '@core/capture/failure'
import { session } from './helpers'

/**
 * Which key store counts as one (KV-175, review of #186), against a stand-in
 * for `safeStorage` — the rule, not Electron, is what is under test.
 */

function storage(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (text) => Buffer.from(`sealed:${text}`),
    decryptString: (bytes) => bytes.toString().replace(/^sealed:/, ''),
    ...over,
  }
}

describe('holdsAKey', () => {
  it('trusts isEncryptionAvailable on Windows and macOS', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(holdsAKey(storage(), platform)).toBe(true)
      expect(holdsAKey(storage({ isEncryptionAvailable: () => false }), platform)).toBe(false)
    }
  })

  it('on Linux counts a real keyring, and never basic_text, though it says available', () => {
    expect(holdsAKey(storage(), 'linux')).toBe(true)
    expect(holdsAKey(storage({ getSelectedStorageBackend: () => 'kwallet6' }), 'linux')).toBe(true)
    const basic = storage({ getSelectedStorageBackend: () => 'basic_text' })
    expect(basic.isEncryptionAvailable()).toBe(true)
    expect(holdsAKey(basic, 'linux')).toBe(false)
  })

  it('does not count a backend asked about before the app was ready', () => {
    expect(holdsAKey(storage({ getSelectedStorageBackend: () => 'unknown' }), 'linux')).toBe(false)
  })
})

describe('osCipher', () => {
  it('seals as base64 and opens what it sealed', () => {
    const cipher = osCipher(storage(), 'win32', async () => true)
    const sealed = cipher.seal('a history')
    expect(Buffer.from(sealed, 'base64').toString()).toBe('sealed:a history')
    expect(cipher.open(sealed)).toBe('a history')
  })

  it('decides whether it encrypts once, and asks whether the key is there each time', async () => {
    let up = true
    const available = storage({ isEncryptionAvailable: () => up })
    const cipher = osCipher(available, 'darwin', async () => true)
    expect(await cipher.keyLanded()).toBe(true)
    up = false
    expect(cipher.holdsKey).toBe(true)
    expect(cipher.encrypts).toBe(true)
    expect(cipher.available()).toBe(false)
  })

  it('says only macOS can mistake a locked key store for a foreign key', () => {
    expect(osCipher(storage(), 'darwin', async () => true).lockedLooksLikeForeign).toBe(true)
    expect(osCipher(storage(), 'win32', async () => true).lockedLooksLikeForeign).toBe(false)
    expect(osCipher(storage(), 'linux', async () => true).lockedLooksLikeForeign).toBe(false)
  })
})

describe('the key on disk before anything is sealed (KV-175)', () => {
  it('seals nothing until the key is on disk, then seals, and stops asking', async () => {
    let onDisk = false
    let asked = 0
    const cipher = osCipher(storage(), 'win32', async () => {
      asked++
      return onDisk
    })
    expect(await cipher.keyLanded()).toBe(false)
    expect(cipher.encrypts).toBe(false)
    onDisk = true
    // Reading `encrypts` asks nothing (review of #187): only `keyLanded` looks.
    expect(cipher.encrypts).toBe(false)
    expect(asked).toBe(1)
    expect(await cipher.keyLanded()).toBe(true)
    expect(cipher.encrypts).toBe(true)
    const after = asked
    onDisk = false
    expect(await cipher.keyLanded()).toBe(true)
    expect(cipher.encrypts).toBe(true)
    expect(asked).toBe(after)
  })

  it('never encrypts where there is no key store, whatever is on disk', async () => {
    const basic = storage({ getSelectedStorageBackend: () => 'basic_text' })
    const cipher = osCipher(basic, 'linux', async () => true)
    expect(await cipher.keyLanded()).toBe(false)
    expect(cipher.holdsKey).toBe(false)
    expect(cipher.encrypts).toBe(false)
  })
})

describe('a sealed history meeting basic_text on Linux (review of #187)', () => {
  it('is reachable, so it is never "locked", while it still never seals', () => {
    const basic = storage({ getSelectedStorageBackend: () => 'basic_text' })
    expect(reachable(basic, 'linux')).toBe(true)
    expect(reachable(storage({ getSelectedStorageBackend: () => 'unknown' }), 'linux')).toBe(false)
    expect(reachable(storage({ isEncryptionAvailable: () => false }), 'win32')).toBe(false)
    const cipher = osCipher(basic, 'linux', async () => true)
    expect(cipher.available()).toBe(true)
    expect(cipher.holdsKey).toBe(false)
  })

  it('will not open here, with set-aside offered, rather than locked forever', async () => {
    // Sealed under a keyring; then the keyring is gone and basic_text answers,
    // with a key that is not the one that sealed it.
    const dir = mkdtempSync(join(tmpdir(), 'kinvue-basic-'))
    try {
      const path = join(dir, 'sessions.json')
      const keyring = osCipher(storage(), 'linux', async () => true)
      expect(await keyring.keyLanded()).toBe(true)
      await createJsonSessionStore(path, undefined, keyring).append(session({ id: 'a' }))
      const basic = osCipher(
        storage({
          getSelectedStorageBackend: () => 'basic_text',
          decryptString: () => {
            throw new Error('not this key')
          },
        }),
        'linux',
        async () => true,
      )
      const store = createJsonSessionStore(path, undefined, basic)
      const listed = await store.list('test-person').catch((e: unknown) => e)
      expect(listed).toBeInstanceOf(UndecryptableStoreError)
      expect(listed).not.toBeInstanceOf(LockedStoreError)
      expect(classifyDashboardError(listed)).toBe('store-undecryptable')
      // The way out exists: the file is set aside, kept, and a new history starts.
      expect(await store.startNewHistory()).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('protectionOf: what the line says, from the file on disk (review of #187)', () => {
  it('says encrypted only of a sealed file, or of nothing the next write would seal', () => {
    expect(protectionOf(true, true, 'sealed')).toBe('encrypted')
    expect(protectionOf(true, true, 'nothing')).toBe('encrypted')
    // The key ready and the file still plain: the seal not landed, or failed.
    expect(protectionOf(true, true, 'plain')).toBe('not-yet-encrypted')
    expect(protectionOf(true, false, 'plain')).toBe('not-yet-encrypted')
    expect(protectionOf(true, false, 'nothing')).toBe('not-yet-encrypted')
  })

  it('says no key store of a plain file, and encrypted of a sealed one regardless', () => {
    expect(protectionOf(false, false, 'plain')).toBe('no-key-store')
    expect(protectionOf(false, false, 'nothing')).toBe('no-key-store')
    expect(protectionOf(false, false, 'sealed')).toBe('encrypted')
  })
})

describe('localStateHoldsKey: whether Chromium has written the key down (Windows)', () => {
  it('answers true only once Local State holds a key, and false for anything less', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinvue-state-'))
    try {
      const path = join(dir, 'Local State')
      const onDisk = localStateHoldsKey(path)
      expect(await onDisk()).toBe(false)
      writeFileSync(path, JSON.stringify({ browser: {} }))
      expect(await onDisk()).toBe(false)
      writeFileSync(path, '{ not json')
      expect(await onDisk()).toBe(false)
      writeFileSync(path, JSON.stringify({ os_crypt: { encrypted_key: '' } }))
      expect(await onDisk()).toBe(false)
      writeFileSync(path, JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEkBAAAA' } }))
      expect(await onDisk()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

