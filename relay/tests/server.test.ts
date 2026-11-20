import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { randomBytes, sign } from 'node:crypto'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENDED,
  HEADERS,
  MAX_BODY_BYTES,
  MAX_SMALL_BODY_BYTES,
  REQUEST_WINDOW_MS,
  ROUTES,
} from '@kinvue/core/sync/protocol'
import {
  createRelayServer,
  FAILURE_WORDS,
  MAX_FAILED_ATTEMPTS,
  safely,
  wordsOf,
} from '../server'
import { createRelayStore, type RelayStore } from '../store'
import { call, identity, listening, receiveKey, sealed, type Identity } from './helpers'

/**
 * The relay over real HTTP, with real Ed25519 signatures (KV-39). Nothing here is mocked
 * but the clock: the routes, the signing and the store are the ones that run.
 */

let dir: string
let store: RelayStore
let server: Server
let base: string
let clock: number
/** What the relay told whoever runs it (KV-225), and a `tell` that can be made to throw. */
let told: string[]
let tellThrows: boolean
const device = identity()
const ann = identity()
const bill = identity()
const stranger = identity()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kinvue-relay-'))
  store = createRelayStore(join(dir, 'relay.json'))
  clock = Date.now()
  await store.enrolDevice(device.key, receiveKey(), clock)
  await store.enrolViewer(ann.key, receiveKey(), clock)
  await store.enrolViewer(bill.key, receiveKey(), clock)
  told = []
  tellThrows = false
  server = createRelayServer({
    store,
    now: () => clock,
    tell: (line) => {
      if (tellThrows) throw new Error('standard error is closed')
      told.push(line)
    },
  })
  base = await listening(server)
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

const post = (envelopes: { viewer: string; stream: number; sealed: string }[]) =>
  call(base, device, { method: 'POST', path: ROUTES.envelopes, body: { envelopes } })
const fetchAs = (who: Identity) =>
  call(base, who, { method: 'GET', path: ROUTES.envelopes, at: clock })

describe('a failure of the relay\u2019s own (KV-225)', () => {
  /** The relay's file can no longer be written: its place is taken by a folder. */
  const fileRefusesWrites = async (): Promise<void> => {
    await rm(join(dir, 'relay.json'))
    await mkdir(join(dir, 'relay.json'))
  }

  it('tells whoever runs it why, with the route, and tells the caller only that it failed', async () => {
    await fileRefusesWrites()
    const secret = sealed('what the envelope holds')
    const answer = await post([{ viewer: ann.key, stream: 1, sealed: secret }])
    expect(answer).toEqual({ status: 500, json: { error: 'the relay failed' } })

    expect(told).toHaveLength(1)
    // The route as the log writes it, then the operating system's own reason.
    expect(told[0]).toMatch(/^The relay failed on POST \/v1\/envelopes: \S.*\.$/)
    expect(told[0]).toMatch(/EPERM|EISDIR|EACCES|ENOTEMPTY|EEXIST/)
    // The log's rule: no key, no body.
    for (const kept of [device.key, ann.key, secret]) expect(told[0]).not.toContain(kept)
  })

  it('names a route by its shape, never by the key in it', async () => {
    await fileRefusesWrites()
    const answer = await call(base, device, {
      method: 'DELETE',
      path: `${ROUTES.viewers}${ann.key}`,
    })
    expect(answer.status).toBe(500)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatch(/^The relay failed on DELETE \/v1\/viewers\/:viewer: /)
    expect(told[0]).not.toContain(ann.key)
  })

  it('tells nothing for a request it refused: that is the caller\u2019s, and in the log', async () => {
    const answer = await call(base, device, { method: 'GET', path: '/v1/nowhere' })
    expect(answer.status).toBe(404)
    expect(told).toEqual([])
  })

  it('tells nothing when the caller hangs up mid-body, signed or not (review of #253)', async () => {
    // A phone leaving Wi-Fi mid-upload is not the relay failing. And the body is read
    // before the signature is checked, so anyone who can reach the port can do this: the
    // headers below are the right shape and signed over nothing.
    const { port } = new URL(base)
    const head = [
      `POST ${ROUTES.envelopes} HTTP/1.1`,
      'Host: relay',
      `${HEADERS.key}: ${stranger.key}`,
      `${HEADERS.at}: ${String(clock)}`,
      `${HEADERS.nonce}: ${randomBytes(16).toString('base64url')}`,
      `${HEADERS.signature}: ${sign(null, Buffer.from('nothing'), stranger.privateKey).toString('base64url')}`,
      'Content-Type: application/json',
      'Content-Length: 1000',
    ].join('\r\n')
    await new Promise<void>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        // Three bytes of the thousand promised, then gone.
        socket.write(`${head}\r\n\r\n{"e`, () => socket.destroy())
      })
      socket.on('close', () => resolve())
      socket.on('error', reject)
    })
    // The relay has seen it go by the time it answers the next request.
    await vi.waitFor(async () => expect((await fetchAs(ann)).status).toBe(200))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(told).toEqual([])
  })

  describe('what it quotes of an error (review of #253)', () => {
    /** A relay whose store fails every fetch with `err`, and what it then tells. */
    const failingWith = async (err: unknown): Promise<string[]> => {
      const said: string[] = []
      const broken = createRelayServer({
        store: { ...store, fetch: () => Promise.reject(err) },
        now: () => clock,
        tell: (line) => said.push(line),
      })
      try {
        const at = await listening(broken)
        const answer = await call(at, ann, { method: 'GET', path: ROUTES.envelopes, at: clock })
        expect(answer).toEqual({ status: 500, json: { error: 'the relay failed' } })
      } finally {
        await new Promise((resolve) => broken.close(resolve))
      }
      return said
    }

    it('leaves out a key, whoever wrote it into the message', async () => {
      // The store has such a message, for a file that holds an ended viewer's key twice.
      // It cannot reach here today only because the file is read before the server
      // starts; this holds whatever the order.
      const said = await failingWith(new Error(`${ann.key}: an ended viewer's key, held again`))
      expect(said).toEqual([
        "The relay failed on GET /v1/envelopes: [left out]: an ended viewer's key, held again.",
      ])
    })

    it('leaves out sealed bytes, and keeps a path of the relay’s own', async () => {
      const bytes = sealed('what an envelope holds, long enough to be told from a word')
      const path = join(dir, 'relay.json')
      const [line] = await failingWith(new Error(`EPERM: operation not permitted, rename '${path}' ${bytes}`))
      expect(line).not.toContain(bytes)
      expect(line).toContain(path)
    })

    it('says a bug in the relay by its name, so it reads apart from a full disk', async () => {
      expect(await failingWith(new TypeError("Cannot read properties of undefined (reading 'waiting')"))).toEqual([
        "The relay failed on GET /v1/envelopes: TypeError: Cannot read properties of undefined (reading 'waiting').",
      ])
      // A plain Error, and the operating system's, say what they said and no more.
      expect(await failingWith(new Error('ENOSPC: no space left on device, write'))).toEqual([
        'The relay failed on GET /v1/envelopes: ENOSPC: no space left on device, write.',
      ])
    })

    it('ends at the first line break of any kind, and carries no control character', () => {
      for (const br of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
        expect(wordsOf(new Error(`first line${br}    at somewhere (stack)`))).toBe('first line')
      }
      // An escape that would move a terminal's cursor, and a bell.
      expect(wordsOf(new Error('disk \u001b[2Kfull\u0007'))).toBe('disk [2Kfull')
    })

    it(`cuts at ${String(FAILURE_WORDS)} characters, by character, and says it was cut`, () => {
      const long = 'full '.repeat(200)
      expect(wordsOf(new Error(long))).toBe(`${long.slice(0, FAILURE_WORDS)}…`)
      expect(wordsOf(new Error('full '.repeat(60)))).toBe('full '.repeat(60).trim())
      // A character that is two code units is never left as half of one.
      const pairs = '\u{1F600} '.repeat(FAILURE_WORDS)
      const cut = wordsOf(new Error(pairs))
      expect(Array.from(cut)).toHaveLength(FAILURE_WORDS + 1)
      expect(cut.endsWith('…')).toBe(true)
      // No first half of a pair without its second.
      expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    })

    it('never throws, whatever it is handed', () => {
      const hostile = new Error('x')
      Object.defineProperty(hostile, 'message', {
        get: () => {
          throw new Error('no message for you')
        },
      })
      const unprintable = {
        toString: () => {
          throw new Error('no string either')
        },
      }
      const numbered = Object.assign(new Error('x'), { message: 42 as unknown as string })
      expect(wordsOf(hostile)).toBe('no reason given')
      expect(wordsOf(unprintable)).toBe('no reason given')
      expect(wordsOf(numbered)).toBe('42')
      expect(wordsOf(undefined)).toBe('undefined')
      expect(wordsOf(new Error(''))).toBe('no reason given')
    })

    it('guards the line being made as well as the telling of it', () => {
      const told: string[] = []
      const say = safely((line) => told.push(line))
      expect(() =>
        say(() => {
          throw new Error('could not make the line')
        }),
      ).not.toThrow()
      expect(() =>
        safely(() => {
          throw new Error('standard error is closed')
        })(() => 'a line'),
      ).not.toThrow()
      say(() => 'a line')
      expect(told).toEqual(['a line'])
    })
  })

  it('still answers when what it tells cannot be written', async () => {
    await fileRefusesWrites()
    tellThrows = true
    const answer = await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])
    expect(answer.status).toBe(500)
    // And goes on serving: a read needs no write.
    tellThrows = false
    expect((await fetchAs(ann)).status).toBe(200)
  })
})

describe('store and forward', () => {
  it('delivers what the device posts to the viewer it was sealed to', async () => {
    const posted = await post([
      { viewer: ann.key, stream: 1, sealed: sealed('one') },
      { viewer: ann.key, stream: 2, sealed: sealed('two') },
    ])
    expect(posted).toEqual({
      status: 200,
      json: { added: 2, replaced: 0, held: 0, acknowledged: 0 },
    })
    const mailbox = await fetchAs(ann)
    expect(mailbox.status).toBe(200)
    expect((mailbox.json as { envelopes: { stream: number }[] }).envelopes.map((e) => e.stream))
      .toEqual([1, 2])
  })

  it('never shows one viewer what waits for another (KV-31)', async () => {
    // Bill has mail of his own, so his fetch reads a mailbox rather than finding none.
    await post([
      { viewer: ann.key, stream: 1, sealed: sealed('for ann') },
      { viewer: bill.key, stream: 1, sealed: sealed('for bill') },
    ])
    const mailbox = (await fetchAs(bill)).json as { envelopes: { sealed: string }[] }
    expect(mailbox.envelopes.map((e) => e.sealed)).toEqual([sealed('for bill')])
  })

  it('records each fetch that delivered something new, and gives the device those times (KV-31)', async () => {
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])
    const first = clock
    await fetchAs(ann)
    // The same envelope again, never acknowledged: handed over, and not a second look
    // (KV-224).
    clock += 1000
    const again = (await fetchAs(ann)).json as { envelopes: { stream: number }[] }
    expect(again.envelopes.map((e) => e.stream)).toEqual([1])
    clock += 1000
    await post([{ viewer: ann.key, stream: 2, sealed: sealed('two') }])
    await fetchAs(ann)
    const deliveries = await call(base, device, { method: 'GET', path: ROUTES.deliveries })
    expect(deliveries.status).toBe(200)
    const viewers = (deliveries.json as { viewers: { viewer: string; fetchedAt: number[] }[] })
      .viewers
    expect(viewers.find((v) => v.viewer === ann.key)?.fetchedAt).toEqual([first, clock])
    expect(viewers.find((v) => v.viewer === bill.key)?.fetchedAt).toEqual([])
  })

  it('records and writes nothing for a fetch that found nothing (review of #216)', async () => {
    // KV-31's history is taken from what the relay delivered. A background poll finding
    // an empty mailbox delivered nothing: kept, it would bury the looks among thousands.
    await fetchAs(ann)
    const deliveries = (await call(base, device, { method: 'GET', path: ROUTES.deliveries }))
      .json as { viewers: { viewer: string; fetchedAt: number[] }[] }
    expect(deliveries.viewers.find((v) => v.viewer === ann.key)?.fetchedAt).toEqual([])
    const before = await stat(join(dir, 'relay.json'))
    clock += 1000
    await fetchAs(ann)
    expect((await stat(join(dir, 'relay.json'))).mtimeMs).toBe(before.mtimeMs)
  })

  it('lets go of what a viewer acknowledges, and does not take it again', async () => {
    await post([
      { viewer: ann.key, stream: 1, sealed: sealed('one') },
      { viewer: ann.key, stream: 2, sealed: sealed('two') },
    ])
    const ack = await call(base, ann, { method: 'POST', path: ROUTES.ack, body: { through: 1 } })
    expect(ack.status).toBe(204)
    const left = (await fetchAs(ann)).json as { envelopes: { stream: number }[] }
    expect(left.envelopes.map((e) => e.stream)).toEqual([2])
    // The outbox sending stream 1 again (#41) is not taken, and is said to be the
    // viewer's already, apart from anything added (review of #216).
    expect(await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])).toEqual({
      status: 200,
      json: { added: 0, replaced: 0, held: 0, acknowledged: 1 },
    })
  })

  it('takes the same envelope twice as one', async () => {
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])
    expect((await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])).json).toEqual({
      added: 0,
      replaced: 0,
      held: 1,
      acknowledged: 0,
    })
  })

  it('refuses an envelope for a non-viewer, and writes none of the batch', async () => {
    const refused = await post([
      { viewer: ann.key, stream: 1, sealed: sealed('one') },
      { viewer: stranger.key, stream: 1, sealed: sealed('who?') },
    ])
    expect(refused.status).toBe(422)
    expect(await fetchAs(ann)).toEqual({ status: 200, json: { envelopes: [] } })
  })

  it('refuses a malformed batch with what was wrong, not the batch itself', async () => {
    const refused = await post([{ viewer: ann.key, stream: 0, sealed: sealed('x') }])
    expect(refused).toEqual({
      status: 400,
      json: { error: 'envelopes[0].stream: not a whole number from 1' },
    })
  })
})

describe('roles', () => {
  it('lets only the check-in device post, read deliveries and end sharing', async () => {
    const asViewer = await call(base, ann, {
      method: 'POST',
      path: ROUTES.envelopes,
      body: { envelopes: [{ viewer: bill.key, stream: 1, sealed: sealed('forged') }] },
    })
    expect(asViewer.status).toBe(403)
    expect((await call(base, ann, { method: 'GET', path: ROUTES.deliveries })).status).toBe(403)
    const revoke = await call(base, ann, { method: 'DELETE', path: ROUTES.viewers + bill.key })
    expect(revoke.status).toBe(403)
    expect((await fetchAs(bill)).status).toBe(200)
  })

  it('lets only a viewer fetch and acknowledge', async () => {
    expect((await fetchAs(device)).status).toBe(403)
    const ack = await call(base, device, { method: 'POST', path: ROUTES.ack, body: { through: 1 } })
    expect(ack.status).toBe(403)
  })

  it('answers a key it never enrolled as not enrolled, whatever it signs', async () => {
    expect(await fetchAs(stranger)).toEqual({ status: 401, json: { error: 'not enrolled' } })
  })
})

describe('signed requests', () => {
  it('refuses a request with no signature', async () => {
    const res = await fetch(base + ROUTES.envelopes)
    expect(res.status).toBe(401)
  })

  it('refuses a body changed after it was signed', async () => {
    const tampered = await call(base, device, {
      method: 'POST',
      path: ROUTES.envelopes,
      body: { envelopes: [{ viewer: ann.key, stream: 1, sealed: sealed('altered') }] },
      signedBody: { envelopes: [{ viewer: ann.key, stream: 1, sealed: sealed('original') }] },
    })
    expect(tampered).toEqual({ status: 401, json: { error: 'bad signature' } })
  })

  it('refuses a signature moved to another route', async () => {
    const moved = await call(base, device, {
      method: 'GET',
      path: ROUTES.deliveries,
      signedPath: ROUTES.envelopes,
    })
    expect(moved).toEqual({ status: 401, json: { error: 'bad signature' } })
  })

  it('refuses a request signed by one key and naming another', async () => {
    const posing = { ...stranger, key: ann.key }
    const res = await call(base, posing, { method: 'GET', path: ROUTES.envelopes })
    expect(res).toEqual({ status: 401, json: { error: 'bad signature' } })
  })

  it.each([
    ['before', -1],
    ['after', 1],
  ])('refuses a request from %s the time window', async (_when, sign) => {
    const at = clock + sign * (REQUEST_WINDOW_MS + 1)
    expect(await call(base, ann, { method: 'GET', path: ROUTES.envelopes, at })).toEqual({
      status: 401,
      json: { error: 'outside the time window' },
    })
  })

  it('accepts one at the edge of it', async () => {
    const at = clock - REQUEST_WINDOW_MS
    expect((await call(base, ann, { method: 'GET', path: ROUTES.envelopes, at })).status).toBe(200)
  })

  it('refuses the same request sent again inside the window', async () => {
    const request = { method: 'GET', path: ROUTES.envelopes, at: clock, nonce: 'n'.repeat(22) }
    expect((await call(base, ann, request)).status).toBe(200)
    expect(await call(base, ann, request)).toEqual({ status: 401, json: { error: 'replayed' } })
  })

  it('spends no nonce on a key nobody enrolled (review of #216)', async () => {
    // Anyone can make a key and sign with it. Recorded, their nonces would fill the
    // ledger; refused before it, the same request twice is "not enrolled" both times.
    const request = { method: 'GET', path: ROUTES.envelopes, at: clock, nonce: 's'.repeat(22) }
    const notEnrolled = { status: 401, json: { error: 'not enrolled' } }
    expect(await call(base, stranger, request)).toEqual(notEnrolled)
    expect(await call(base, stranger, request)).toEqual(notEnrolled)
  })

  it('refuses a body over the limit, and says so', async () => {
    const big = { envelopes: [{ viewer: ann.key, stream: 1, sealed: 'a'.repeat(MAX_BODY_BYTES) }] }
    const res = await call(base, device, { method: 'POST', path: ROUTES.envelopes, body: big })
    expect(res).toEqual({ status: 413, json: { error: 'body too large' } })
  })

  it('refuses an unsigned request before reading its body (review of #216)', async () => {
    // Anyone can send a body; only a signed request from inside the window gets one read.
    const big = 'a'.repeat(MAX_BODY_BYTES + 1)
    const res = await fetch(base + ROUTES.envelopes, { method: 'POST', body: big })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'not signed' })
  })
})

describe('what a bad signature can cost the relay (KV-226)', () => {
  /** A body of `bytes` bytes, as JSON. */
  const padded = (bytes: number) => ({ through: 1, pad: 'a'.repeat(bytes) })

  it('reads at most 4 KiB on a route that takes a small body, signed or not', async () => {
    // Ann is enrolled, and signs this one properly: the limit is the route's.
    const ack = await call(base, ann, {
      method: 'POST',
      path: ROUTES.ack,
      body: padded(MAX_SMALL_BODY_BYTES),
    })
    expect(ack).toEqual({ status: 413, json: { error: 'body too large' } })
    // A stranger, signed over nothing, gets no further.
    const stranger_ = await call(base, stranger, {
      method: 'POST',
      path: ROUTES.ack,
      body: padded(MAX_SMALL_BODY_BYTES),
      signedBody: {},
    })
    expect(stranger_).toEqual({ status: 413, json: { error: 'body too large' } })
  })

  it('reads a large post of envelopes only under the check-in device’s key', async () => {
    const big = (viewer: string) => ({
      envelopes: [{ viewer, stream: 1, sealed: 'a'.repeat(64 * 1024) }],
    })
    // The device: read in full, and taken.
    const posted = await call(base, device, {
      method: 'POST',
      path: ROUTES.envelopes,
      body: big(ann.key),
    })
    expect(posted.status).toBe(200)
    // A viewer, properly signed: held to the small limit before anything else is asked.
    const asViewer = await call(base, ann, {
      method: 'POST',
      path: ROUTES.envelopes,
      body: big(bill.key),
    })
    expect(asViewer).toEqual({ status: 413, json: { error: 'body too large' } })
    // A key nobody enrolled gets the same answer as a viewer's: it says nothing of which.
    const asStranger = await call(base, stranger, {
      method: 'POST',
      path: ROUTES.envelopes,
      body: big(bill.key),
    })
    expect(asStranger).toEqual(asViewer)
  })

  it('cuts a body that never says its length at the same 4 KiB', async () => {
    // Chunked, with no Content-Length to refuse it on: the reading itself has to stop.
    const { port } = new URL(base)
    const head = [
      `POST ${ROUTES.ack} HTTP/1.1`,
      'Host: relay',
      `${HEADERS.key}: ${stranger.key}`,
      `${HEADERS.at}: ${String(clock)}`,
      `${HEADERS.nonce}: ${randomBytes(16).toString('base64url')}`,
      `${HEADERS.signature}: ${sign(null, Buffer.from('nothing'), stranger.privateKey).toString('base64url')}`,
      'Transfer-Encoding: chunked',
      'Connection: close',
    ].join('\r\n')
    const chunk = 'a'.repeat(1024)
    const answer = await new Promise<string>((resolve, reject) => {
      let said = ''
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(`${head}\r\n\r\n`)
        // Five chunks of 1 KiB: past the limit, and never ended.
        for (let i = 0; i < 5; i += 1) socket.write(`400\r\n${chunk}\r\n`)
      })
      socket.on('data', (d: Buffer) => {
        said += d.toString('utf8')
        if (said.includes('body too large') || said.includes('not signed')) {
          socket.destroy()
          resolve(said)
        }
      })
      socket.on('close', () => resolve(said))
      socket.on('error', reject)
    })
    expect(answer).toMatch(/^HTTP\/1\.1 413 /)
    expect(answer).toContain('body too large')
  })

  it('counts no bad signature at a closed route, so nobody is locked out of check-ins', async () => {
    // Behind a reverse proxy every request has one address: counted here, a stranger
    // could stop the household's own devices. Ann's real requests come from the same
    // address as the stranger's bad ones.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i += 1) {
      const forged = await call(base, ann, {
        method: 'POST',
        path: ROUTES.ack,
        body: { through: 1 },
        signedBody: { through: 2 },
      })
      expect(forged.status).toBe(401)
    }
    expect((await fetchAs(ann)).status).toBe(200)
    expect((await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])).status).toBe(200)
    // Nor do they count toward the open routes' limit: enrolment still answers on its
    // merits, not "too many attempts".
    const enrol = await call(base, stranger, {
      method: 'POST',
      path: ROUTES.enrol,
      body: { token: 'n'.repeat(22), receiveKey: receiveKey() },
    })
    expect(enrol.status).not.toBe(429)
  })
})

describe('ending a viewer’s sharing', () => {
  it('drops their mailbox and their enrolment in one step', async () => {
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])
    const revoke = await call(base, device, { method: 'DELETE', path: ROUTES.viewers + ann.key })
    expect(revoke.status).toBe(204)
    const deliveries = (await call(base, device, { method: 'GET', path: ROUTES.deliveries }))
      .json as { viewers: { viewer: string }[] }
    expect(deliveries.viewers.map((v) => v.viewer)).toEqual([bill.key])
    // The device sealing to them by mistake, after: nothing is taken for them.
    expect((await post([{ viewer: ann.key, stream: 2, sealed: sealed('two') }])).status).toBe(422)
  })

  it('tells them, on every route, that sharing ended and nothing more (KV-31)', async () => {
    await call(base, device, { method: 'DELETE', path: ROUTES.viewers + ann.key })
    expect(await fetchAs(ann)).toEqual({ status: 410, json: ENDED })
    const ack = await call(base, ann, { method: 'POST', path: ROUTES.ack, body: { through: 1 } })
    expect(ack).toEqual({ status: 410, json: ENDED })
  })

  it('still tells them so after any gap, so their app deletes its copy', async () => {
    await call(base, device, { method: 'DELETE', path: ROUTES.viewers + ann.key })
    clock += 365 * 24 * 60 * 60 * 1000
    expect(await fetchAs(ann)).toEqual({ status: 410, json: ENDED })
  })

  it('leaves every other viewer as they were', async () => {
    await post([{ viewer: bill.key, stream: 1, sealed: sealed('for bill') }])
    await call(base, device, { method: 'DELETE', path: ROUTES.viewers + ann.key })
    const mailbox = (await fetchAs(bill)).json as { envelopes: unknown[] }
    expect(mailbox.envelopes).toHaveLength(1)
  })

  it('answers a key that was never a viewer as not one', async () => {
    const res = await call(base, device, { method: 'DELETE', path: ROUTES.viewers + stranger.key })
    expect(res.status).toBe(404)
  })
})

describe('where a viewer’s stream stands (review of #216)', () => {
  const streams = async (who: Identity) =>
    ((await fetchAs(who)).json as { envelopes: { stream: number; sealed: string }[] }).envelopes

  it('takes a reseal of a stream still waiting in place of the old bytes', async () => {
    // Resealing gives different bytes every time. Refused, the device could never send a
    // waiting stream again, and delivery would stall until the envelope expired.
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('first seal') }])
    const resealed = await post([{ viewer: ann.key, stream: 1, sealed: sealed('second seal') }])
    expect(resealed).toEqual({
      status: 200,
      json: { added: 0, replaced: 1, held: 0, acknowledged: 0 },
    })
    expect(await streams(ann)).toEqual([
      { stream: 1, sealed: sealed('second seal'), postedAt: clock },
    ])
  })

  it('refuses an ack past a stream it never held, and keeps everything waiting', async () => {
    // Stream 2 delayed: acknowledged past, it could never be delivered, and neither side
    // would know. A caregiver would read an unbroken run of days with one missing.
    await post([
      { viewer: ann.key, stream: 1, sealed: sealed('one') },
      { viewer: ann.key, stream: 3, sealed: sealed('three') },
    ])
    const ack = await call(base, ann, { method: 'POST', path: ROUTES.ack, body: { through: 3 } })
    expect(ack).toEqual({ status: 422, json: { error: 'stream 2 not held here' } })
    expect((await streams(ann)).map((e) => e.stream)).toEqual([1, 3])
    // Up to the gap is fine; then stream 2 arrives, and the rest can go.
    expect(
      (await call(base, ann, { method: 'POST', path: ROUTES.ack, body: { through: 1 } })).status,
    ).toBe(204)
    await post([{ viewer: ann.key, stream: 2, sealed: sealed('two') }])
    expect(
      (await call(base, ann, { method: 'POST', path: ROUTES.ack, body: { through: 3 } })).status,
    ).toBe(204)
    expect(await streams(ann)).toEqual([])
  })

  it('refuses an ack far past anything held, without counting up to it', async () => {
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])
    const through = Number.MAX_SAFE_INTEGER
    const ack = await call(base, ann, { method: 'POST', path: ROUTES.ack, body: { through } })
    expect(ack).toEqual({ status: 422, json: { error: 'stream 2 not held here' } })
  })

  it('tells the device where each viewer stands, so it can resume', async () => {
    await post([
      { viewer: ann.key, stream: 1, sealed: sealed('one') },
      { viewer: ann.key, stream: 2, sealed: sealed('two') },
    ])
    await fetchAs(ann)
    await call(base, ann, { method: 'POST', path: ROUTES.ack, body: { through: 1 } })
    type Standing = { viewer: string; ackedThrough: number; highestWaiting: number | null }
    const deliveries = (await call(base, device, { method: 'GET', path: ROUTES.deliveries }))
      .json as { viewers: Standing[] }
    const standing = (key: string) => deliveries.viewers.find((v) => v.viewer === key)
    expect(standing(ann.key)).toMatchObject({ ackedThrough: 1, highestWaiting: 2 })
    expect(standing(bill.key)).toMatchObject({ ackedThrough: 0, highestWaiting: null })
  })
})
