import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { HEADERS, requestBytes } from '@kinvue/core/sync/protocol'
import { hashOf } from '../keys'

/** A device's signing identity, as the relay names it: its raw Ed25519 public key. */
export interface Identity {
  key: string
  privateKey: KeyObject
}

/** Both key types are 32 raw bytes after a 12-byte SPKI header (RFC 8410). */
const raw = (publicKey: KeyObject): string =>
  publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64url')

export function identity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { key: raw(publicKey), privateKey }
}

/** An X25519 key a viewer would be sealed to. The relay only stores it. */
export const receiveKey = (): string => raw(generateKeyPairSync('x25519').publicKey)

export interface Call {
  method: string
  path: string
  body?: unknown
  /** The request's time; the relay's clock unless a test moves it. */
  at?: number
  nonce?: string
  /** Signed over this body, sent with the real one: a body altered in transit. */
  signedBody?: unknown
  /** Signed over this path, sent to the real one: a signature moved to another route. */
  signedPath?: string
}

export interface Answer {
  status: number
  json: unknown
}

/** A signed request from `who`, sent to the relay at `base`. */
export async function call(base: string, who: Identity, request: Call): Promise<Answer> {
  const text = request.body === undefined ? '' : JSON.stringify(request.body)
  const signedText =
    request.signedBody === undefined ? text : JSON.stringify(request.signedBody)
  const at = request.at ?? Date.now()
  const nonce = request.nonce ?? randomBytes(16).toString('base64url')
  const bytes = requestBytes({
    method: request.method,
    path: request.signedPath ?? request.path,
    at,
    nonce,
    bodyHash: hashOf(Buffer.from(signedText, 'utf8')),
  })
  const signature = sign(null, Buffer.from(bytes, 'utf8'), who.privateKey).toString('base64url')
  const res = await fetch(base + request.path, {
    method: request.method,
    headers: {
      [HEADERS.key]: who.key,
      [HEADERS.at]: String(at),
      [HEADERS.nonce]: nonce,
      [HEADERS.signature]: signature,
      ...(text === '' ? {} : { 'content-type': 'application/json' }),
    },
    body: text === '' ? undefined : text,
  })
  const body = await res.text()
  return { status: res.status, json: body === '' ? null : JSON.parse(body) }
}

/** `server` listening on a free port on loopback, and its base URL. */
export async function listening(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A sealed box's stand-in. The relay never opens one, so any base64url will do. */
export const sealed = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')
