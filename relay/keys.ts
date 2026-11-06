import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * The relay's only cryptography: checking that a request was signed by the key it names,
 * and hashing a body for `requestBytes` (KV-39). It never seals, opens or signs anything.
 *
 * `node:crypto` speaks Ed25519 natively, so nothing is added for it. A key arrives as its
 * 32 raw bytes; Node takes a public key as DER, so the fixed SPKI header for Ed25519 goes
 * in front (RFC 8410).
 */

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')

/** Whether `signature` is `key`'s over `bytes`. False, never a throw, for any malformed input. */
export function signedBy(key: string, bytes: string, signature: string): boolean {
  try {
    const raw = Buffer.from(key, 'base64url')
    if (raw.length !== 32) return false
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, raw]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(bytes, 'utf8'), publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

/** A body's SHA-256 in hex, as `SignedRequest.bodyHash` names it. */
export const hashOf = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
