import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
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
 * Errors say what was wrong with the request in a few words, and never repeat its body.
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
  /** How long a request may take to send its headers: `HEADERS_TIMEOUT_MS`, unless given. */
  headersTimeoutMs?: number
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

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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
    req.on('error', reject)
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
 */
export function expireEvery(store: RelayStore, every: number, now: () => number): () => void {
  const timer = setInterval(() => {
    store.expire(now()).catch(() => undefined)
  }, every)
  timer.unref()
  return () => clearInterval(timer)
}

export function createRelayServer({
  store,
  now = Date.now,
  log = () => {},
  headersTimeoutMs = HEADERS_TIMEOUT_MS,
}: RelayOptions): Server {
  const fresh = nonceLedger()
  const attempts = attemptLedger()

  /**
   * What a request says about who sent it and when, checked before a byte of its body is
   * read: a request with no signature, or from outside the time window, or announcing a
   * body over the limit, is refused without the relay holding anything for it (review of
   * #216). The signature itself needs the body's hash, so it is checked after, in `signer`.
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
    const length = Number(header(req, 'content-length') ?? 0)
    if (length > MAX_BODY_BYTES) throw new Refusal(413, 'body too large')
    return { key, at, nonce, signature, clock }
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
      const body = await readBody(req)
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

  /** When each connection opened, so a request Node cuts is logged with how long it held one. */
  const opened = new WeakMap<object, number>()

  const server = createServer({ connectionsCheckingInterval: CONNECTIONS_CHECK_MS }, (req, res) => {
    const started = now()
    res.on('finish', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const entry = { method: req.method ?? '', route: routeOf(path), status: res.statusCode }
      record({ ...entry, ms: now() - started })
    })
    route(req, res).catch((err: unknown) => {
      if (err instanceof Refusal) {
        if (!res.headersSent) send(res, err.status, { error: err.reason })
        return
      }
      if (!res.headersSent) send(res, 500, { error: 'the relay failed' })
    })
  })
  server.headersTimeout = headersTimeoutMs
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.maxConnections = MAX_CONNECTIONS
  const stopExpiring = expireEvery(store, EXPIRE_EVERY_MS, now)
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
