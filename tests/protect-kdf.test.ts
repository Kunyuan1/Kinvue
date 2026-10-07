import { describe, expect, it, vi } from 'vitest'
import { unprotect, type ProtectedExport } from '@core/session/protect'

/**
 * scrypt failing inside `unprotect` (review of #187): memory it could not have,
 * or an OpenSSL error. Its own file, because it stands in for `node:crypto`.
 */

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  scrypt: (...args: unknown[]) => {
    const done = args.at(-1) as (err: Error | null, key?: Buffer) => void
    done(new Error('Invalid scrypt params: memory limit exceeded'))
  },
}))

const file: ProtectedExport = {
  kind: 'kinvue-history',
  version: 2,
  protection: {
    kdf: 'scrypt',
    N: 2 ** 17,
    r: 8,
    p: 1,
    salt: 'AA==',
    cipher: 'aes-256-gcm',
    iv: 'AA==',
    tag: 'AA==',
  },
  sealed: 'AA==',
}

describe('unprotect when scrypt fails', () => {
  it('says the file could not be opened, and does not throw', async () => {
    expect(await unprotect(file, 'blue kettle morning')).toEqual({
      ok: false,
      why: 'unreadable',
      detail: 'it could not be opened on this computer',
    })
  })
})
