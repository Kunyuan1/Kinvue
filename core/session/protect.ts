import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { EXPORT_KIND, MIN_PASSPHRASE_LENGTH, type HistoryExport } from './lifecycle'

export { MIN_PASSPHRASE_LENGTH }

/**
 * An export protected with a passphrase the person chose (KV-175, T16). It
 * cannot use the operating system's key — it exists to be restored somewhere
 * else — so the key is derived from the passphrase: scrypt, then AES-256-GCM,
 * from Node's own `crypto`, with no new dependency.
 *
 * **Still a Kinvue export** (review of #186): the same `kind`, its container
 * `version` raised to 2, the scrypt parameters and the sealed bytes in place of
 * the records. A build that knows no protection refuses it as made by a newer
 * version — true — rather than "not a Kinvue export", about a file Kinvue made.
 *
 * In `core/`, beside `planRestore`: `node:crypto` is allowed here, and the
 * rules are tested in plain node.
 */

/** The container version a protected export says. The plain one stays `EXPORT_VERSION`. */
export const PROTECTED_EXPORT_VERSION = 2

/**
 * scrypt at the cost recommended for interactive use (N = 2^17, r = 8, p = 1):
 * about a second, once, when a file is made or opened. Stored in the file, so
 * a later build can raise it and still open what this one made.
 */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 }

/** The most scrypt may be asked to use reading a file: bounds what a crafted header can demand. */
const MAX_N = 2 ** 20

export interface ProtectedExport {
  kind: typeof EXPORT_KIND
  version: typeof PROTECTED_EXPORT_VERSION
  protection: {
    kdf: 'scrypt'
    N: number
    r: number
    p: number
    /** base64 */
    salt: string
    cipher: 'aes-256-gcm'
    /** base64 */
    iv: string
    /** base64: GCM's tag, which a wrong passphrase or a changed byte fails. */
    tag: string
  }
  /** base64: the plain export, sealed. */
  sealed: string
}

const deriveKey = (
  passphrase: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // `maxmem` above scrypt's own 32 MB default: 128 × N × r bytes at N = 2^17.
    scrypt(passphrase.normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err === null ? resolve(key) : reject(err),
    )
  })

/**
 * What the GCM tag also covers: everything in the file but the sealed bytes,
 * so a header changed to other parameters fails to open rather than opening
 * with them.
 */
const additionalData = (file: Omit<ProtectedExport, 'sealed'>): Buffer => {
  const { tag: _tag, ...header } = file.protection
  return Buffer.from(JSON.stringify({ kind: file.kind, version: file.version, ...header }))
}

/** `file` sealed with a key derived from `passphrase`. */
export async function protect(file: HistoryExport, passphrase: string): Promise<ProtectedExport> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`A passphrase needs at least ${String(MIN_PASSPHRASE_LENGTH)} characters.`)
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(passphrase, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p)
  const header: Omit<ProtectedExport, 'sealed'> = {
    kind: EXPORT_KIND,
    version: PROTECTED_EXPORT_VERSION,
    protection: {
      kdf: 'scrypt',
      ...SCRYPT,
      salt: salt.toString('base64'),
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: '',
    },
  }
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(additionalData(header))
  const sealed = Buffer.concat([cipher.update(JSON.stringify(file), 'utf8'), cipher.final()])
  return {
    ...header,
    protection: { ...header.protection, tag: cipher.getAuthTag().toString('base64') },
    sealed: sealed.toString('base64'),
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `file` says it is a protected export of this version — before any passphrase. */
export function isProtected(file: unknown): file is ProtectedExport {
  return (
    isObject(file) &&
    file.kind === EXPORT_KIND &&
    file.version === PROTECTED_EXPORT_VERSION &&
    isObject(file.protection) &&
    typeof file.sealed === 'string'
  )
}

/** What opening a protected export found. */
export type Unprotected =
  | { ok: true; contents: unknown }
  /**
   * The tag did not match: the wrong passphrase, or a changed byte. GCM cannot
   * say which, so the sentence names both.
   */
  | { ok: false; why: 'wrong-passphrase' }
  | { ok: false; why: 'unreadable'; detail: string }

const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0

/** The plain export inside `file`, opened with `passphrase`, or why it would not open. */
export async function unprotect(file: ProtectedExport, passphrase: string): Promise<Unprotected> {
  const { kdf, N, r, p, salt, cipher, iv, tag } = file.protection
  // The header is the file's word, so it is bounded before scrypt is asked to
  // honour it: a crafted N would otherwise take as much memory as it named.
  if (
    kdf !== 'scrypt' ||
    cipher !== 'aes-256-gcm' ||
    !isPowerOfTwo(N) ||
    N > MAX_N ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 32 ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 16 ||
    typeof salt !== 'string' ||
    typeof iv !== 'string' ||
    typeof tag !== 'string'
  ) {
    return { ok: false, why: 'unreadable', detail: 'its protection is not one this app knows' }
  }
  const key = await deriveKey(passphrase, Buffer.from(salt, 'base64'), N, r, p)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAAD(additionalData(file))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const text = Buffer.concat([
      decipher.update(Buffer.from(file.sealed, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    try {
      return { ok: true, contents: JSON.parse(text) as unknown }
    } catch {
      const detail = 'it opened, and what it holds is not an export'
      return { ok: false, why: 'unreadable', detail }
    }
  } catch {
    return { ok: false, why: 'wrong-passphrase' }
  }
}
