/**
 * How the check-in device, its viewers and the household's relay talk (KV-39).
 *
 * The relay is KV-33's: it stores and forwards sealed envelopes it cannot read, and keeps
 * when each viewer fetched, for the access history the person sees (KV-31). It never
 * scores, opens or composes anything, so nothing here knows what an envelope holds —
 * `sealed` is opaque bytes, sealed to one viewer by the check-in device (#41) and opened
 * only on that viewer's device (#42).
 *
 * Here, rather than in `relay/`, because three apps speak it: the desktop app sends, the
 * caregiver client fetches, the relay sits between. One definition, so the three cannot
 * drift apart.
 *
 * **No cryptography in this file.** Requests are signed with each device's Ed25519 key,
 * but the signing and the checking are done by whoever holds a crypto library — the relay
 * with `node:crypto` — over the bytes `requestBytes` gives. That keeps `@kinvue/core`
 * free of dependencies, and leaves the choice of library to each app.
 */

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

/** Named in what every request signs, so a signature for anything else cannot pass. */
export const PROTOCOL = 'kinvue-relay/1'

/**
 * How far a request's time may be from the relay's clock, either way. A signed request
 * replayed later than this is refused on its time alone; inside it, on its nonce.
 */
export const REQUEST_WINDOW_MS = 5 * MINUTE_MS

/**
 * How long a sealed envelope waits for its viewer, at most (KV-33). An envelope not
 * fetched by then is dropped: the check-in device is the outbox, not the relay, and seals
 * it again when that viewer asks from their last stream number (#41).
 */
export const ENVELOPE_RETENTION_MS = 14 * DAY_MS

/** How long the relay keeps when each viewer fetched: #31's access-history window. */
export const DELIVERY_RETENTION_MS = 30 * DAY_MS

/** The headers a signed request carries. Lower case, as Node reads them. */
export const HEADERS = {
  key: 'kinvue-key',
  at: 'kinvue-at',
  nonce: 'kinvue-nonce',
  signature: 'kinvue-signature',
} as const

export const ROUTES = {
  /** POST by the check-in device: envelopes into viewers' mailboxes. GET by a viewer. */
  envelopes: '/v1/envelopes',
  /** POST by a viewer: everything up to a stream number may go. */
  ack: '/v1/ack',
  /** GET by the check-in device: when each viewer fetched. */
  deliveries: '/v1/deliveries',
  /** DELETE by the check-in device, followed by the viewer's key: sharing ends. */
  viewers: '/v1/viewers/',
} as const

/** What a request signs. `bodyHash` is the SHA-256 of the body's bytes, in hex. */
export interface SignedRequest {
  method: string
  path: string
  at: number
  nonce: string
  bodyHash: string
}

/**
 * The bytes a request is signed over: one field per line, the protocol first. The path
 * is as sent, query included. Every field is in it, so a signature cannot be moved to
 * another route, another body, or another time.
 */
export const requestBytes = (request: SignedRequest): string =>
  [
    PROTOCOL,
    request.method.toUpperCase(),
    request.path,
    String(request.at),
    request.nonce,
    request.bodyHash,
  ].join('\n')

/** One envelope, sealed to one viewer, at its place in that viewer's stream (KV-33). */
export interface Envelope {
  /** The viewer's signing key: their identity here. */
  viewer: string
  /** Its number in that viewer's stream, from 1. Signed inside the envelope too. */
  stream: number
  /** The sealed box, base64url. Opaque to the relay. */
  sealed: string
}

/** POST /v1/envelopes. */
export interface PostEnvelopes {
  envelopes: Envelope[]
}

/** An envelope waiting for its viewer, as they fetch it. */
export interface Waiting {
  stream: number
  sealed: string
  postedAt: number
}

/** GET /v1/envelopes: what waits for the viewer asking, lowest stream first. */
export interface Mailbox {
  envelopes: Waiting[]
}

/** POST /v1/ack: the viewer holds everything up to and including `through`. */
export interface Ack {
  through: number
}

/** GET /v1/deliveries: when each viewer fetched, inside the access-history window. */
export interface Deliveries {
  viewers: { viewer: string; fetchedAt: number[] }[]
}

/**
 * What a viewer whose sharing has ended is told, and all they are told: no date, no
 * reason, nothing to react to (KV-31).
 */
export const ENDED = { status: 'ended' } as const
export type Ended = typeof ENDED

/** The largest sealed envelope accepted, in base64url characters: a record is a few KB. */
export const MAX_SEALED_CHARS = 256 * 1024

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** An Ed25519 or X25519 public key: 32 bytes, base64url without padding. */
export const isKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 43 && BASE64URL.test(value)

/** A request's nonce: 16 to 64 base64url characters, at least 96 random bits. */
export const isNonce = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 16 && value.length <= 64 && BASE64URL.test(value)

/** An Ed25519 signature: 64 bytes, base64url without padding. */
export const isSignature = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 86 && BASE64URL.test(value)

const isStream = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why `value` is not a POST /v1/envelopes body, or null when it is. */
export function checkPostEnvelopes(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.envelopes)) return 'envelopes: not a list'
  if (value.envelopes.length === 0) return 'envelopes: empty'
  for (const [i, envelope] of value.envelopes.entries()) {
    const at = `envelopes[${i}]`
    if (!isObject(envelope)) return `${at}: not an object`
    if (!isKey(envelope.viewer)) return `${at}.viewer: not a key`
    if (!isStream(envelope.stream)) return `${at}.stream: not a whole number from 1`
    const { sealed } = envelope
    if (typeof sealed !== 'string' || sealed.length === 0 || !BASE64URL.test(sealed)) {
      return `${at}.sealed: not base64url`
    }
    if (sealed.length > MAX_SEALED_CHARS) return `${at}.sealed: longer than ${MAX_SEALED_CHARS}`
  }
  return null
}

/** Why `value` is not a POST /v1/ack body, or null when it is. */
export function checkAck(value: unknown): string | null {
  if (!isObject(value)) return 'ack: not an object'
  if (!isStream(value.through)) return 'through: not a whole number from 1'
  return null
}
