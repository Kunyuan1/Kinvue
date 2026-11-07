import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  checkAck,
  checkPostEnvelopes,
  ENDED,
  HEADERS,
  isKey,
  isNonce,
  isSignature,
  MAX_BODY_BYTES,
  requestBytes,
  REQUEST_WINDOW_MS,
  ROUTES,
  type Ack,
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
 * Errors say what was wrong with the request in a few words, and never repeat its body.
 */


export interface RelayOptions {
  store: RelayStore
  /** The relay's clock, in milliseconds. */
  now?: () => number
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

export function createRelayServer({ store, now = Date.now }: RelayOptions): Server {
  const fresh = nonceLedger()

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

  /** Who signed this request, checked against its body, or a refusal. */
  async function signer(req: IncomingMessage, claimed: Claim, body: Buffer) {
    const { key, at, nonce, signature, clock } = claimed
    const bytes = requestBytes({
      method: req.method ?? '',
      path: req.url ?? '',
      at,
      nonce,
      bodyHash: hashOf(body),
    })
    if (!signedBy(key, bytes, signature)) throw new Refusal(401, 'bad signature')
    const role = await store.roleOf(key)
    if (role === null) throw new Refusal(401, 'not enrolled')
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
    const claimed = claim(req)
    const body = await readBody(req)
    const { key, role } = await signer(req, claimed, body)
    if (role === 'ended') {
      send(res, 410, ENDED)
      return
    }
    const path = (req.url ?? '').split('?')[0] ?? ''
    const at = now()

    if (path === ROUTES.envelopes && req.method === 'POST') {
      only(role, 'device')
      const value = parseJson(body)
      const problem = checkPostEnvelopes(value)
      if (problem !== null) throw new Refusal(400, problem)
      const result = await store.post((value as PostEnvelopes).envelopes, at)
      if (result.kind === 'unknown-viewer') throw new Refusal(422, 'not a viewer here')
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

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (err instanceof Refusal) {
        if (!res.headersSent) send(res, err.status, { error: err.reason })
        return
      }
      if (!res.headersSent) send(res, 500, { error: 'the relay failed' })
    })
  })
}
