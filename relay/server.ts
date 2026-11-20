import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerOptions,
  type ServerResponse,
} from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { Socket } from 'node:net'
import {
  checkAck,
  checkEnrol,
  checkJoin,
  checkPostEnvelopes,
  ENDED,
  HEADERS,
  isKey,
  isNonce,
  isPairingId,
  isSignature,
  MAX_BODY_BYTES,
  MAX_SMALL_BODY_BYTES,
  requestBytes,
  REQUEST_TIMEOUT_MS,
  REQUEST_WINDOW_MS,
  ROUTES,
  type Ack,
  type Enrol,
  type Join,
  type Joined,
  type Mailbox,
  type PostEnvelopes,
  type Posted,
} from '@kinvue/core/sync/protocol'
import { hashOf, signedBy } from './keys'
import type { RelayStore, Role } from './store'

/**
 * The household's relay, as HTTP (KV-39). Five routes, each for one role:
 *
 * - the check-in device posts envelopes, reads when each viewer fetched, and ends a
 *   viewer's sharing;
 * - a viewer fetches its own mailbox and acknowledges what it holds.
 *
 * **Every request is signed** by the key it names (`HEADERS`), over `requestBytes`: its
 * method, path, time, a nonce and its body's hash. A request outside `REQUEST_WINDOW_MS`
 * of this clock, or with a nonce already seen inside it, is refused, so a captured request
 * cannot be sent again. Nonces are kept in memory only: a restart forgets them, so a
 * request captured in the five minutes before one could be replayed once after it. Every
 * write it could make is idempotent — an envelope already held, an ack already taken, a
 * viewer already ended — except a fetch that finds envelopes waiting, which records one
 * delivery that did not happen. Small, but it lands in the access history a person reads
 * to judge who is looking (review of #216), so #40's wording for that history should not
 * present it as exact.
 *
 * **A viewer reaches only its own mailbox.** It is named by the key that signed, never by
 * anything in the request, so there is no way to ask for another's (KV-31: viewers cannot
 * see each other).
 *
 * **A viewer whose sharing ended is told so, and only so** (KV-31), on any route, once its
 * signature checks out. That answer is what makes their app delete its copy.
 *
 * **Two routes take a key nobody enrolled yet**: the check-in device redeeming the
 * household's token, and a viewer joining a pairing (KV-39; the protocol says why each is
 * safe to open). Both are signed by that key, and both are one-shot, so neither spends a
 * nonce. They are the ones a stranger can reach, so failures there are counted per address,
 * and an address that fails `MAX_FAILED_ATTEMPTS` times inside `ATTEMPT_WINDOW_MS` is
 * refused until the window passes. Behind a reverse proxy every request has the proxy's
 * address, and the limit is then one for everyone: fail-closed, which is the right way
 * round for the routes that let someone in.
 *
 * **What it logs** (`log`): each request's method, its route with any id or key left out,
 * its status, and how long it took. Never a body, a key, a header or an address — a log is
 * where health data leaks from first (#46), and these hold nothing that needs one.
 *
 * **What it tells** (`tell`, KV-225): its own failures, for whoever runs it — a request
 * it could not carry out, a retention run that failed. Under the log's rule, and never
 * for anything a caller did: a request refused, or one cut off before it was whole, is
 * the caller's and tells nothing.
 *
 * Errors say what was wrong with the request in a few words, and never repeat its body.
 *
 * **What a bad signature can cost it is bounded by size, not by counting** (KV-226). A
 * signature is checked against the body, so the body is read first. Only the check-in
 * device posting envelopes gets `MAX_BODY_BYTES`, about 4 MB, and only when the key it
 * claims is the device's; every other request is held to `MAX_SMALL_BODY_BYTES`, 4 KiB.
 * Bad signatures are counted against an address only at the two open routes, where a
 * stranger is guessing at a way in. Counted everywhere, a stranger behind the same reverse
 * proxy as the household — every request has the proxy's address — could lock the
 * household's own devices out of carrying check-ins, which is not the fail-closed choice
 * the open routes make: refusing someone in is safe, refusing everyone's check-ins is not.
 */

/** Failed attempts at the two open routes one address may make inside the window. */
export const MAX_FAILED_ATTEMPTS = 10

/** How long a failed attempt at an open route is counted against its address. */
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000

/**
 * How often the attempt ledger forgets addresses whose failures have aged out. Its own, so
 * how often nonces are swept never changes it (second review of #218).
 */
export const ATTEMPT_SWEEP_MS = 30 * 1000

/**
 * How long a request may take to send its headers. The whole request's limit is the
 * protocol's `REQUEST_TIMEOUT_MS`, stated against the largest body it allows.
 */
export const HEADERS_TIMEOUT_MS = 10 * 1000

/** One line of the relay's log: nothing in it about who, or what was sent. */
export interface LogEntry {
  method: string
  /** The route as written in `ROUTES`, with ids and keys as `:pairing` and `:viewer`. */
  route: string
  status: number
  ms: number
}

export interface RelayOptions {
  store: RelayStore
  /** The relay's clock, in milliseconds. */
  now?: () => number
  /** Where each request's `LogEntry` goes. Nowhere, unless given. */
  log?: (entry: LogEntry) => void
  /**
   * Where a failure of the relay's own is said, in words for whoever runs it (KV-225):
   * standard error, in `main`. Nowhere, unless given. See `wordsOf` and `safely`.
   */
  tell?: (line: string) => void
  /** How long a request may take to send its headers: `HEADERS_TIMEOUT_MS`, unless given. */
  headersTimeoutMs?: number
  /**
   * The relay's certificate and its key, PEM. Given, it serves HTTPS; not, plain HTTP —
   * which `relay/main.ts` allows on loopback only, where a reverse proxy in front of it
   * terminates TLS (#46).
   */
  tls?: { cert: string | Buffer; key: string | Buffer }
}

/** The longest a failure's own words are quoted at, in characters: an error, not a transcript. */
export const FAILURE_WORDS = 300

/** Where a quoted message ends: the first line break of any kind. */
const LINE_BREAK = /[\r\n\u2028\u2029]/
/** What is left of a line once it is cut: nothing that can move a terminal's cursor. */
const CONTROL = /\p{Cc}/gu
/**
 * Anything shaped like a key, a signature, a nonce's worth of random or sealed bytes: a
 * run of 40 or more of the characters those are written in. A key is 43 of them.
 */
const KEY_LIKE = /[A-Za-z0-9_-]{40,}/g

/**
 * What an error says, for a line told to whoever runs the relay (KV-225): its name where
 * that says something, and its message, on one line and no longer than `FAILURE_WORDS`.
 *
 * **The log's rule holds here too, and here is where it is kept: no key, no body, no
 * address** (review of #253). These are the relay's own failures — a full disk, a rename
 * refused, a file it cannot read — and what they quote is the relay's file and the
 * operating system's reason. But a message is whatever its thrower wrote, and the store
 * has one that names a key (a file holding an ended viewer's key twice). So this does not
 * trust the message: anything in it shaped like a key or sealed bytes is left out,
 * whoever wrote it. A path of the relay's own is short of that shape and stays, which is
 * what a reader needs from a failed rename.
 *
 * Cut at the first line break so an error that carries more — a stack, a cause — cannot
 * bring it along, and cleared of control characters so nothing in it can redraw the line
 * it is printed on. The name is kept when it is not plain `Error`: `TypeError: …` is a
 * bug in the relay, and `ENOSPC: …` is a disk, and whoever reads this should be able to
 * tell which (review of #253).
 *
 * Never throws, whatever it is handed: a thrown value is by definition unexpected, and
 * this runs where the relay is already failing.
 */
export function wordsOf(err: unknown): string {
  let said: string
  try {
    const message: unknown = err instanceof Error ? err.message : err
    const text = typeof message === 'string' ? message : String(message)
    const name: unknown = err instanceof Error ? err.name : undefined
    said = typeof name === 'string' && name !== '' && name !== 'Error' ? `${name}: ${text}` : text
  } catch {
    return 'no reason given'
  }
  const line = (said.split(LINE_BREAK, 1)[0] ?? '')
    .replace(CONTROL, '')
    .replace(KEY_LIKE, '[left out]')
    .trim()
  if (line === '') return 'no reason given'
  // By character, not by code unit: half of a pair is not a character.
  const characters = Array.from(line)
  return characters.length > FAILURE_WORDS
    ? `${characters.slice(0, FAILURE_WORDS).join('')}…`
    : line
}

/**
 * `tell`, made safe to call where a throw would be an unhandled rejection or an uncaught
 * exception (KV-225, review of #253): the line is built and told inside one guard, so
 * neither a `tell` that throws nor a line that cannot be made is one more thing to fail.
 * A line that cannot be told is the one thing lost, as a log line is.
 *
 * A stream that fails later, with an `'error'` event and no throw — a closed pipe — is
 * not something this can see; `relay/main.ts` listens for that on the streams it writes.
 */
export function safely(tell: (line: string) => void): (line: () => string) => void {
  return (line) => {
    try {
      tell(line())
    } catch {
      // Dropped.
    }
  }
}

/** A path as its route, for the log: what it names left out. */
export function routeOf(path: string): string {
  if (path.startsWith(ROUTES.viewers)) return `${ROUTES.viewers}:viewer`
  const pairing = /^\/v1\/pairings\/[^/]+(\/viewer|\/confirm)?$/.exec(path)
  if (pairing !== null) return `${ROUTES.pairings}/:pairing${pairing[1] ?? ''}`
  const known: string[] = Object.values(ROUTES)
  return known.includes(path) ? path : 'unknown'
}

/**
 * Failed attempts at the open routes, by address, inside the window. Strangers reach it by
 * design, from as many addresses as they like, so it is swept of every address whose
 * failures have all aged out — every `ATTEMPT_SWEEP_MS`, as the nonce ledger is — and not
 * only when that address comes back (review of #218). Exported for its test.
 */
export function attemptLedger() {
  const failures = new Map<string, number[]>()
  let sweptAt = -Infinity
  const sweep = (now: number): void => {
    if (now - sweptAt < ATTEMPT_SWEEP_MS) return
    sweptAt = now
    for (const [address, times] of failures) {
      if (times.every((t) => now - t >= ATTEMPT_WINDOW_MS)) failures.delete(address)
    }
  }
  const recent = (address: string, now: number): number[] => {
    sweep(now)
    const kept = (failures.get(address) ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS)
    if (kept.length === 0) failures.delete(address)
    else failures.set(address, kept)
    return kept
  }
  return {
    allowed: (address: string, now: number): boolean =>
      recent(address, now).length < MAX_FAILED_ATTEMPTS,
    failed: (address: string, now: number): void => {
      failures.set(address, [...recent(address, now), now])
    },
    /** How many addresses it holds. */
    size: (): number => failures.size,
  }
}

/** A request's signing headers, read and checked for shape and time. */
interface Claim {
  key: string
  at: number
  nonce: string
  signature: string
  /** The relay's clock when the request arrived. */
  clock: number
}

/** The one refusal before a key is proven that cost the relay work: counted at open routes. */
const BAD_SIGNATURE = 'bad signature'

/**
 * A request that ended before it was whole: the caller hung up, or lost its network, or
 * Node cut it for taking too long (review of #253). Not a refusal — there is nobody left
 * to answer — and not the relay's failure, so it is never told: these lines are what
 * monitoring watches, and a phone leaving Wi-Fi mid-upload is not an alarm. It matters
 * more because the body is read before the signature is checked, so anyone who can reach
 * the port can cut a request short.
 */
class Cut extends Error {
  constructor() {
    super('the request was cut off')
  }
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason)
  }
}

const send = (res: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

const readBody = (req: IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // Answered, then the rest is read and dropped, so the answer reaches the sender
        // rather than a connection cut under it.
        req.removeAllListeners('data')
        req.resume()
        reject(new Refusal(413, 'body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    // The request's own stream failing is the request being cut, whatever Node calls it
    // (`aborted`, `ECONNRESET`). And closed without ending is the same thing said another
    // way; a promise settles once, so after `end` this changes nothing.
    req.on('error', () => reject(new Cut()))
    req.on('close', () => reject(new Cut()))
  })

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new Refusal(400, 'body is not JSON')
  }
}

/** How often the nonce ledger is swept of nonces whose requests would be refused on time. */
export const NONCE_SWEEP_MS = 30 * 1000

/**
 * Nonces seen inside the window. Swept every `NONCE_SWEEP_MS` rather than on every request,
 * so the cost of a request does not grow with how many came before it (review of #216).
 * Only enrolled keys reach it, so its size is bounded by what they send.
 */
function nonceLedger() {
  const seen = new Map<string, number>()
  let sweptAt = -Infinity
  return (key: string, nonce: string, at: number, now: number): boolean => {
    if (now - sweptAt >= NONCE_SWEEP_MS) {
      for (const [id, until] of seen) if (until < now) seen.delete(id)
      sweptAt = now
    }
    const id = `${key}:${nonce}`
    if (seen.has(id)) return false
    seen.set(id, at + REQUEST_WINDOW_MS)
    return true
  }
}

/**
 * How often Node checks its connections against the timeouts. Node only notices a timeout
 * when it checks, and by default it checks every 30 seconds — so a 10-second header limit
 * cut at up to 30, and every timeout here was late by as much (second review of #218).
 */
export const CONNECTIONS_CHECK_MS = 1000

/**
 * The most connections held at once. A household's relay has a device and a few viewers;
 * this bounds what slow connections can tie up while each runs out its minute (second
 * review of #218).
 */
export const MAX_CONNECTIONS = 64

/**
 * How often retention runs whether or not anything is written (second review of #218).
 * Reads write nothing, so a relay gone quiet — nobody checking in, nobody fetching — would
 * otherwise keep envelopes past 14 days and fetch times past 30, for as long as it stayed
 * quiet. An hour late is the most retention is now.
 */
export const EXPIRE_EVERY_MS = 60 * 60 * 1000

/**
 * Runs `store.expire` every `every` milliseconds until the returned function is called. The
 * timer does not keep the process alive, and a failed run is left for the next: the file
 * holds what it held, and nothing is half written.
 *
 * **A failed run is told, each time** (KV-225). Dropped silently, envelopes stayed past
 * their 14 days and fetch times past their 30 with nothing anywhere to say so, which is
 * the one promise the relay makes about what it keeps. And the first run to work after a
 * failure is told too, so whoever reads the lines knows it has stopped failing rather
 * than stopped being said.
 */
export function expireEvery(
  store: RelayStore,
  every: number,
  now: () => number,
  tell: (line: string) => void = () => {},
): () => void {
  // Guarded here, not left to the caller: this is exported, and a `tell` that threw in
  // either handler below would be an unhandled rejection (review of #253).
  const say = safely(tell)
  let failing = false
  const timer = setInterval(() => {
    store.expire(now()).then(
      () => {
        if (failing) say(() => 'Retention ran again: what is past its time has been dropped.')
        failing = false
      },
      (err: unknown) => {
        failing = true
        say(
          () =>
            `Retention could not run, so envelopes and fetch times past their time are still ` +
            `kept: ${wordsOf(err)}. It is tried again within the hour.`,
        )
      },
    )
  }, every)
  timer.unref()
  return () => clearInterval(timer)
}

export function createRelayServer({
  store,
  now = Date.now,
  log = () => {},
  tell = () => {},
  headersTimeoutMs = HEADERS_TIMEOUT_MS,
  tls,
}: RelayOptions): Server {
  const fresh = nonceLedger()
  const attempts = attemptLedger()

  /**
   * What a request says about who sent it and when, checked before a byte of its body is
   * read: a request with no signature, or from outside the time window, is refused without
   * the relay holding anything for it (review of #216). The signature itself needs the
   * body's hash, so it is checked after, in `signer`; how much body is read for it is
   * `bodyLimit`'s.
   */
  function claim(req: IncomingMessage): Claim {
    const key = header(req, HEADERS.key)
    const atText = header(req, HEADERS.at)
    const nonce = header(req, HEADERS.nonce)
    const signature = header(req, HEADERS.signature)
    if (!isKey(key) || !isNonce(nonce) || !isSignature(signature) || atText === undefined) {
      throw new Refusal(401, 'not signed')
    }
    const at = Number(atText)
    const clock = now()
    if (!Number.isSafeInteger(at) || Math.abs(clock - at) > REQUEST_WINDOW_MS) {
      throw new Refusal(401, 'outside the time window')
    }
    return { key, at, nonce, signature, clock }
  }

  /**
   * How much body is read for a request, before its signature can be checked (KV-226):
   * `MAX_BODY_BYTES` for envelopes posted under the check-in device's key, and
   * `MAX_SMALL_BODY_BYTES` for everything else. Decided by the key the request claims, so a
   * stranger with any signature is read 4 KiB, and only someone holding the device's public
   * key can make the relay read more — which a forged signature then fails, as before. The
   * answer is the same for every key that is not the device's, so it says nothing about
   * whether a key is enrolled.
   */
  async function bodyLimit(req: IncomingMessage, path: string, key: string): Promise<number> {
    const posting = req.method === 'POST' && path === ROUTES.envelopes
    return posting && (await store.roleOf(key)) === 'device' ? MAX_BODY_BYTES : MAX_SMALL_BODY_BYTES
  }

  /**
   * Who signed this request, checked against its body, or a refusal. `open` is for the two
   * routes a key not yet enrolled may use: there its role is null, and it spends no nonce.
   */
  async function signer(req: IncomingMessage, claimed: Claim, body: Buffer, open: boolean) {
    const { key, at, nonce, signature, clock } = claimed
    const bytes = requestBytes({
      method: req.method ?? '',
      path: req.url ?? '',
      at,
      nonce,
      bodyHash: hashOf(body),
    })
    if (!signedBy(key, bytes, signature)) throw new Refusal(401, BAD_SIGNATURE)
    const role = await store.roleOf(key)
    if (role === null) {
      if (open) return { key, role }
      throw new Refusal(401, 'not enrolled')
    }
    // Last: after the signature, so a forged request cannot spend a nonce someone else will
    // send, and after the role, so a key nobody enrolled spends none at all — the ledger
    // grows only with what enrolled keys send (review of #216).
    if (!fresh(key, nonce, at, clock)) throw new Refusal(401, 'replayed')
    return { key, role }
  }

  const only = (role: Role, wanted: Role): void => {
    if (role === wanted) return
    throw new Refusal(403, wanted === 'device' ? 'for the check-in device' : 'for a viewer')
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const joining = /^\/v1\/pairings\/([^/]+)\/viewer$/.exec(path)?.[1]
    const open = req.method === 'POST' && (path === ROUTES.enrol || joining !== undefined)
    const address = req.socket.remoteAddress ?? 'unknown'
    if (open && !attempts.allowed(address, now())) throw new Refusal(429, 'too many attempts')
    /**
     * A refusal at an open route, counted against its address. What counts (reviews of
     * #218): a bad signature, which cost a body read and a verification to find; and every
     * guess at a token or a pairing. Not what is refused on headers alone — unsigned, or
     * outside the time window — which costs nothing, and the second of which is a device
     * whose clock has drifted, better told so every time than locked out. Not what a request
     * the key really signed got wrong in its body, or a conflict it could not have known
     * about: that is a client with a bug, or a household that forgot a device was enrolled,
     * and locking them out helps no one.
     */
    const failed = (status: number, reason: string): Refusal => {
      attempts.failed(address, now())
      return new Refusal(status, reason)
    }
    let proven: { key: string; role: Role | null; body: Buffer }
    try {
      const claimed = claim(req)
      const limit = await bodyLimit(req, path, claimed.key)
      if (Number(header(req, 'content-length') ?? 0) > limit) {
        throw new Refusal(413, 'body too large')
      }
      const body = await readBody(req, limit)
      proven = { ...(await signer(req, claimed, body, open)), body }
    } catch (err) {
      if (open && err instanceof Refusal && err.reason === BAD_SIGNATURE) {
        throw failed(err.status, err.reason)
      }
      throw err
    }
    const { key, role, body } = proven
    const at = now()

    if (path === ROUTES.enrol && req.method === 'POST') {
      const value = parseJson(body)
      const problem = checkEnrol(value)
      if (problem !== null) throw new Refusal(400, problem)
      const { token, receiveKey } = value as Enrol
      const result = await store.redeem(token, { key, receiveKey }, at)
      if (result === 'invalid') throw failed(401, 'not a token here')
      if (result === 'device-exists') throw new Refusal(409, 'a check-in device is enrolled')
      if (result === 'key-in-use') throw new Refusal(409, 'that key is in use here')
      send(res, 204)
      return
    }
    if (joining !== undefined && req.method === 'POST') {
      // Before the ended check: a viewer whose sharing ended may be approved again (KV-31).
      if (!isPairingId(joining)) throw failed(404, 'no such pairing')
      const value = parseJson(body)
      const problem = checkJoin(value)
      if (problem !== null) throw new Refusal(400, problem)
      const result = await store.join(joining, { key, receiveKey: (value as Join).receiveKey }, at)
      if (result.kind === 'unknown') throw failed(404, 'no such pairing')
      if (result.kind === 'taken') throw failed(409, 'someone joined it already')
      if (result.kind === 'key-in-use') throw new Refusal(409, 'that key is in use here')
      const joined: Joined = { device: result.device }
      send(res, 200, joined)
      return
    }
    if (role === null) throw new Refusal(401, 'not enrolled')
    if (role === 'ended') {
      send(res, 410, ENDED)
      return
    }

    if (path === ROUTES.envelopes && req.method === 'POST') {
      only(role, 'device')
      const value = parseJson(body)
      const problem = checkPostEnvelopes(value)
      if (problem !== null) throw new Refusal(400, problem)
      const result = await store.post((value as PostEnvelopes).envelopes, at)
      if (result.kind === 'unknown-viewer') throw new Refusal(422, 'not a viewer here')
      if (result.kind === 'full') throw new Refusal(507, 'a mailbox is full')
      const { added, replaced, held, acknowledged } = result
      const posted: Posted = { added, replaced, held, acknowledged }
      send(res, 200, posted)
      return
    }
    if (path === ROUTES.envelopes && req.method === 'GET') {
      only(role, 'viewer')
      const mailbox: Mailbox = { envelopes: await store.fetch(key, at) }
      send(res, 200, mailbox)
      return
    }
    if (path === ROUTES.ack && req.method === 'POST') {
      only(role, 'viewer')
      const value = parseJson(body)
      const problem = checkAck(value)
      if (problem !== null) throw new Refusal(400, problem)
      const acked = await store.ack(key, (value as Ack).through, at)
      if (acked.kind === 'gap') throw new Refusal(422, `stream ${acked.missing} not held here`)
      send(res, 204)
      return
    }
    if (path === ROUTES.deliveries && req.method === 'GET') {
      only(role, 'device')
      send(res, 200, await store.deliveries(at))
      return
    }
    if (path === ROUTES.pairings && req.method === 'POST') {
      only(role, 'device')
      send(res, 201, await store.openPairing(at))
      return
    }
    const pairing = /^\/v1\/pairings\/([^/]+)(\/confirm)?$/.exec(path)
    if (pairing !== null) {
      only(role, 'device')
      const [, id = '', confirming] = pairing
      if (!isPairingId(id)) throw new Refusal(404, 'no such pairing')
      if (confirming !== undefined && req.method === 'POST') {
        const result = await store.confirm(id, at)
        if (result === 'unknown') throw new Refusal(404, 'no such pairing')
        if (result === 'nobody-joined') throw new Refusal(409, 'nobody has joined it')
        if (result === 'key-in-use') throw new Refusal(409, 'that key is in use here')
        send(res, 204)
        return
      }
      if (confirming === undefined && req.method === 'GET') {
        const found = await store.pairing(id, at)
        if (found === null) throw new Refusal(404, 'no such pairing')
        send(res, 200, found)
        return
      }
      if (confirming === undefined && req.method === 'DELETE') {
        if (!(await store.closePairing(id, at))) throw new Refusal(404, 'no such pairing')
        send(res, 204)
        return
      }
    }
    if (path.startsWith(ROUTES.viewers) && req.method === 'DELETE') {
      only(role, 'device')
      const viewer = path.slice(ROUTES.viewers.length)
      if (!isKey(viewer)) throw new Refusal(400, 'not a key')
      if (!(await store.revoke(viewer, at))) throw new Refusal(404, 'not a viewer here')
      send(res, 204)
      return
    }
    throw new Refusal(404, 'no such route')
  }

  /**
   * The log, written so it cannot stop the relay (review of #218): this runs in an event
   * handler, where a throw is an uncaught exception, and a full disk or a closed pipe
   * behind the log is no reason to stop carrying a household's check-ins.
   */
  const record = (entry: LogEntry): void => {
    try {
      log(entry)
    } catch {
      // Dropped: a line that cannot be written is the one thing lost.
    }
  }

  /** A failure said, and never one more thing to fail (KV-225): see `safely`. */
  const say = safely(tell)

  /** When each connection opened, so a request Node cuts is logged with how long it held one. */
  const opened = new WeakMap<object, number>()

  const options: ServerOptions = { connectionsCheckingInterval: CONNECTIONS_CHECK_MS }
  const serve = (handler: RequestListener): Server =>
    tls === undefined
      ? createServer(options, handler)
      : // An HTTPS server is an HTTP server underneath, with every option here, and every
        // event but one: `tlsClientError`, handled below.
        (createTlsServer(
          // A handshake gets the headers' time, not TLS's own two minutes (review of #219).
          { ...options, ...tls, handshakeTimeout: headersTimeoutMs },
          handler,
        ) as unknown as Server)
  const server = serve((req, res) => {
    const started = now()
    // The request as the log names it: its method, and its route with ids and keys left out.
    const method = req.method ?? ''
    const named = routeOf((req.url ?? '').split('?')[0] ?? '')
    res.on('finish', () => {
      record({ method, route: named, status: res.statusCode, ms: now() - started })
    })
    route(req, res).catch((err: unknown) => {
      if (err instanceof Refusal) {
        if (!res.headersSent) send(res, err.status, { error: err.reason })
        return
      }
      // The caller went away before the request was whole: nobody to answer, and nothing
      // of the relay's to tell (review of #253).
      if (err instanceof Cut) return
      // The relay's own failure: a full disk, a rename refused. The caller is told only
      // that it failed; why is for whoever runs it, with the route as the log writes it
      // and nothing of the request (KV-225). Without this a run of 500s had no cause
      // anywhere.
      say(() => `The relay failed on ${method} ${named}: ${wordsOf(err)}.`)
      if (!res.headersSent) send(res, 500, { error: 'the relay failed' })
    })
  })
  server.headersTimeout = headersTimeoutMs
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.maxConnections = MAX_CONNECTIONS
  /**
   * On HTTPS, what fails before the handshake completes — plain HTTP to the port, a client
   * it cannot agree a version with, a scanner — never reaches `clientError` (reviews of
   * #219). Logged here as one line, as `clientError` logs its own, and the socket closed.
   */
  if (tls !== undefined) {
    server.on('tlsClientError', (_err: Error, socket: Socket) => {
      // The TLS socket wraps the one `connection` timestamped; Node keeps that as `_parent`.
      const raw = (socket as Socket & { _parent?: Socket })._parent ?? socket
      record({ method: '', route: 'unknown', status: 400, ms: now() - (opened.get(raw) ?? now()) })
      socket.destroy()
    })
  }
  const stopExpiring = expireEvery(store, EXPIRE_EVERY_MS, now, tell)
  server.on('close', stopExpiring)
  server.on('connection', (socket) => opened.set(socket, now()))
  /**
   * What Node answers before a request reaches `route` — a request cut by the timeouts
   * above (408), headers too large (431), or one it could not parse (400) — written as
   * Node would, and logged
   * (review of #218). Without this, the slow requests the timeouts are there to cut would
   * leave no trace, and a flood of them would read as an idle relay.
   */
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy()
      return
    }
    const status =
      err.code === 'ERR_HTTP_REQUEST_TIMEOUT'
        ? 408
        : err.code === 'HPE_HEADER_OVERFLOW'
          ? 431
          : 400
    const head = `HTTP/1.1 ${status} ${STATUS_CODES[status]}`
    socket.end(`${head}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    record({ method: '', route: 'unknown', status, ms: now() - (opened.get(socket) ?? now()) })
  })
  return server
}
