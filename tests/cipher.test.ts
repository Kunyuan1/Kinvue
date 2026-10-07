import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  holdsAKey,
  localStateHoldsKey,
  osCipher,
  type SafeStorageLike,
} from '../app/main/cipher'

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
    const cipher = osCipher(storage(), 'win32', () => true)
    const sealed = cipher.seal('a history')
    expect(Buffer.from(sealed, 'base64').toString()).toBe('sealed:a history')
    expect(cipher.open(sealed)).toBe('a history')
  })

  it('decides whether it encrypts once, and asks whether the key is there each time', () => {
    let up = true
    const cipher = osCipher(storage({ isEncryptionAvailable: () => up }), 'darwin', () => true)
    up = false
    expect(cipher.encrypts).toBe(true)
    expect(cipher.available()).toBe(false)
  })

  it('says only macOS can mistake a locked key store for a foreign key', () => {
    expect(osCipher(storage(), 'darwin', () => true).lockedLooksLikeForeign).toBe(true)
    expect(osCipher(storage(), 'win32', () => true).lockedLooksLikeForeign).toBe(false)
    expect(osCipher(storage(), 'linux', () => true).lockedLooksLikeForeign).toBe(false)
  })
})

describe('the key on disk before anything is sealed (KV-175)', () => {
  it('seals nothing until the key is on disk, then seals, and stops asking', () => {
    let onDisk = false
    let asked = 0
    const cipher = osCipher(storage(), 'win32', () => {
      asked++
      return onDisk
    })
    expect(cipher.encrypts).toBe(false)
    expect(cipher.protection()).toBe('waiting-for-key')
    onDisk = true
    expect(cipher.encrypts).toBe(true)
    expect(cipher.protection()).toBe('encrypted')
    const after = asked
    onDisk = false
    expect(cipher.encrypts).toBe(true)
    expect(asked).toBe(after)
  })

  it('says there is no key store where there is none, whatever is on disk', () => {
    const basic = storage({ getSelectedStorageBackend: () => 'basic_text' })
    const cipher = osCipher(basic, 'linux', () => true)
    expect(cipher.encrypts).toBe(false)
    expect(cipher.protection()).toBe('no-key-store')
  })
})

describe('localStateHoldsKey: whether Chromium has written the key down (Windows)', () => {
  it('answers true only once Local State holds a key, and false for anything less', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinvue-state-'))
    try {
      const path = join(dir, 'Local State')
      const onDisk = localStateHoldsKey(path)
      expect(onDisk()).toBe(false)
      writeFileSync(path, JSON.stringify({ browser: {} }))
      expect(onDisk()).toBe(false)
      writeFileSync(path, '{ not json')
      expect(onDisk()).toBe(false)
      writeFileSync(path, JSON.stringify({ os_crypt: { encrypted_key: '' } }))
      expect(onDisk()).toBe(false)
      writeFileSync(path, JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEkBAAAA' } }))
      expect(onDisk()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

