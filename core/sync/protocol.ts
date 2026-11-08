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
  /** POST by the check-in device, once, with the household's one-time token (KV-39). */
  enrol: '/v1/enrol',
  /**
   * POST by the check-in device: a pairing opens. Followed by its id: GET (who joined) and
   * DELETE (closed) by the device; `/viewer` POST by the viewer joining; `/confirm` POST by
   * the device, once the code matched on both screens.
   */
  pairings: '/v1/pairings',
} as const

/**
 * **How anyone gets in: no open sign-up** (KV-35).
 *
 * - **The check-in device** redeems a one-time token that the household — the relay's
 *   operator — makes on the relay itself. Anyone who can make one has the relay's shell,
 *   and so has everything else already. Once a device is enrolled, no token enrols
 *   another: replacing it is the recovery card's business (#45).
 * - **A viewer** is enrolled only by a pairing the check-in device opened, joined by the
 *   viewer and then confirmed at the device (KV-31). The relay passes the keys between
 *   them; the code both screens show is derived from all four on the devices (#40), so a
 *   relay that swapped a key is caught there, not here.
 *
 * The two routes a key not yet enrolled may use are these. Both are signed by that key,
 * which proves it is held, and both are one-shot — a token redeems once, a pairing takes
 * one viewer — so replaying either does nothing more.
 */

/** How long a household's one-time enrolment token can be redeemed. */
export const ENROL_TOKEN_TTL_MS = 15 * MINUTE_MS

/** How long a pairing stays open: long enough to compare a code over the phone. */
export const PAIRING_TTL_MS = 10 * MINUTE_MS

/** POST /v1/enrol, signed by the device's signing key. */
export interface Enrol {
  token: string
  /** The device's X25519 key, which viewers' pairing code is derived from too. */
  receiveKey: string
}

/** The two public keys a device or a viewer is known by. */
export interface Keys {
  key: string
  receiveKey: string
}

/** POST /v1/pairings: the pairing the device shows, and until when. */
export interface Opened {
  pairing: string
  expiresAt: number
}

/** POST /v1/pairings/:id/viewer, signed by the joining viewer's signing key. */
export interface Join {
  receiveKey: string
}

/** What the joining viewer is given: the device's keys, for its half of the code. */
export interface Joined {
  device: Keys
}

/** GET /v1/pairings/:id: who has joined, for the device's half of the code. */
export interface Pairing extends Opened {
  viewer: Keys | null
}

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

/**
 * **Where a viewer's stream stands, and who says so** (review of #216). Three rules, each
 * needed by the others:
 *
 * - **The relay is the authority on what a viewer acknowledged** (`ackedThrough`), and
 *   says it in `Deliveries`. The device resumes from there — after a reinstall, an older
 *   backup, or envelopes expiring in the relay — rather than from what it believes it sent.
 * - **An acknowledgement is contiguous.** `through` means the viewer holds every stream up
 *   to it, so an ack past a stream the relay never held for them is refused: acknowledged
 *   anyway, that stream could never be delivered, and neither side would know.
 * - **The device may send any stream again until it is acknowledged.** A stream still
 *   waiting is replaced by the new bytes — resealing gives different bytes every time, and
 *   it is the same sender correcting its own undelivered mail. A stream already
 *   acknowledged is not taken again, and the answer counts it as such (`acknowledged`),
 *   apart from what was added.
 */

/** POST /v1/envelopes. */
export interface PostEnvelopes {
  envelopes: Envelope[]
}

/** What a POST /v1/envelopes did with each envelope it was sent. */
export interface Posted {
  /** New in a mailbox. */
  added: number
  /** Took the place of different bytes at a stream still waiting: a reseal. */
  replaced: number
  /** Already there, byte for byte: a resend. */
  held: number
  /** At or below the viewer's acknowledged stream: not taken, since they hold it. */
  acknowledged: number
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

/** One viewer, as GET /v1/deliveries gives them to the check-in device. */
export interface ViewerStanding {
  viewer: string
  /** When the relay delivered envelopes to them, inside the access-history window. */
  fetchedAt: number[]
  /** Every stream up to this one is acknowledged; 0 before the first. */
  ackedThrough: number
  /** The highest stream waiting for them, or null when nothing is. */
  highestWaiting: number | null
}

/** GET /v1/deliveries: each viewer's deliveries, and where their stream stands. */
export interface Deliveries {
  viewers: ViewerStanding[]
}

/**
 * What a viewer whose sharing has ended is told, and all they are told: no date, no
 * reason, nothing to react to (KV-31).
 */
export const ENDED = { status: 'ended' } as const
export type Ended = typeof ENDED

/**
 * **The limits on a post, stated in terms of each other** (review of #216), so a sender
 * that keeps to the first two can never be refused by the third.
 *
 * A sealed record is a few KB, the pain note included; 64K characters is far past any.
 * Six weeks offline is 42 days of one person's check-ins for one viewer, so 64 envelopes
 * a post sends it in one; a device with more to send sends more posts. The body allows
 * the largest such post, with room for each envelope's JSON around its bytes.
 */
export const MAX_SEALED_CHARS = 64 * 1024

/** The most envelopes in one POST /v1/envelopes. */
export const MAX_ENVELOPES_PER_POST = 64

/**
 * The most envelopes waiting for one viewer. Fourteen days' retention of a few check-ins a
 * day is a few dozen; this is room for a household many times over, and a ceiling on what
 * one mailbox can make the relay hold (KV-39).
 */
export const MAX_WAITING_PER_VIEWER = 1024

/** What one envelope's JSON adds around its sealed bytes: its key, stream and quoting. */
const ENVELOPE_JSON_CHARS = 128

/** The largest body the relay reads: the largest post the two limits above allow. */
export const MAX_BODY_BYTES = MAX_ENVELOPES_PER_POST * (MAX_SEALED_CHARS + ENVELOPE_JSON_CHARS) + 64

const BASE64URL = /^[A-Za-z0-9_-]+$/

/**
 * The base64url characters whose two low bits are zero: the only ones that can end 32
 * bytes. The 43rd character carries the last four bits of the key and two spare ones.
 */
const KEY_LAST = /[AEIMQUYcgkosw048]$/

/**
 * An Ed25519 or X25519 public key: 32 bytes, base64url without padding, **spelled the one
 * way that encodes them** (review of #216). Every lookup is by this string, so a key that
 * could also be written three other ways would have three other names: a removed viewer
 * coming back under one would be "not enrolled" rather than told sharing ended, and a
 * keypair could be enrolled twice. Checked by the alphabet, not by decoding, so core needs
 * no `Buffer`.
 */
export const isKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 43 && BASE64URL.test(value) && KEY_LAST.test(value)

/** A request's nonce: 16 to 64 base64url characters, at least 96 random bits. */
export const isNonce = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 16 && value.length <= 64 && BASE64URL.test(value)

/** An Ed25519 signature: 64 bytes, base64url without padding. */
export const isSignature = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 86 && BASE64URL.test(value)

/** A sealed envelope's bytes as sent: base64url, not empty, no longer than the limit. */
export const isSealed = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_SEALED_CHARS &&
  BASE64URL.test(value)

/** A stream number: a whole number from 1. */
export const isStream = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why `value` is not a POST /v1/envelopes body, or null when it is. */
export function checkPostEnvelopes(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.envelopes)) return 'envelopes: not a list'
  if (value.envelopes.length === 0) return 'envelopes: empty'
  if (value.envelopes.length > MAX_ENVELOPES_PER_POST) {
    return `envelopes: more than ${MAX_ENVELOPES_PER_POST}`
  }
  for (const [i, envelope] of value.envelopes.entries()) {
    const at = `envelopes[${i}]`
    if (!isObject(envelope)) return `${at}: not an object`
    if (!isKey(envelope.viewer)) return `${at}.viewer: not a key`
    if (!isStream(envelope.stream)) return `${at}.stream: not a whole number from 1`
    const { sealed } = envelope
    if (typeof sealed === 'string' && sealed.length > MAX_SEALED_CHARS) {
      return `${at}.sealed: longer than ${MAX_SEALED_CHARS}`
    }
    if (!isSealed(sealed)) return `${at}.sealed: not base64url`
  }
  return null
}

/** A pairing's id: ten characters of Crockford's base32, 50 random bits, easy to read out. */
export const isPairingId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{10}$/.test(value)

/** A one-time enrolment token: 16 random bytes, base64url. */
export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 22 && BASE64URL.test(value)

/** Why `value` is not a POST /v1/enrol body, or null when it is. */
export function checkEnrol(value: unknown): string | null {
  if (!isObject(value)) return 'enrol: not an object'
  if (!isToken(value.token)) return 'token: not a token'
  if (!isKey(value.receiveKey)) return 'receiveKey: not a key'
  return null
}

/** Why `value` is not a POST /v1/pairings/:id/viewer body, or null when it is. */
export function checkJoin(value: unknown): string | null {
  if (!isObject(value)) return 'join: not an object'
  if (!isKey(value.receiveKey)) return 'receiveKey: not a key'
  return null
}

/** Why `value` is not a POST /v1/ack body, or null when it is. */
export function checkAck(value: unknown): string | null {
  if (!isObject(value)) return 'ack: not an object'
  if (!isStream(value.through)) return 'through: not a whole number from 1'
  return null
}
