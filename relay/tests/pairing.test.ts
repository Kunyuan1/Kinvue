import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ENDED,
  ENROL_TOKEN_TTL_MS,
  MAX_ENVELOPES_PER_POST,
  MAX_WAITING_PER_VIEWER,
  PAIRING_TTL_MS,
  ROUTES,
} from '@kinvue/core/sync/protocol'
import {
  ATTEMPT_WINDOW_MS,
  createRelayServer,
  MAX_FAILED_ATTEMPTS,
  routeOf,
  type LogEntry,
} from '../server'
import { createRelayStore, type RelayStore } from '../store'
import { call, identity, listening, receiveKey, sealed, type Identity } from './helpers'

/**
 * How anyone gets in (KV-39): the check-in device by the household's one-time token, a
 * viewer by a pairing the device opened and confirmed. Over real HTTP, with real
 * signatures; only the clock is the test's.
 */

let dir: string
let store: RelayStore
let server: Server
let base: string
let clock: number
let logged: LogEntry[]
const device = identity()
const deviceReceive = receiveKey()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kinvue-relay-pairing-'))
  store = createRelayStore(join(dir, 'relay.json'))
  clock = Date.now()
  logged = []
  server = createRelayServer({ store, now: () => clock, log: (entry) => logged.push(entry) })
  base = await listening(server)
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

const enrol = (who: Identity, token: string, receive = receiveKey()) =>
  call(base, who, {
    method: 'POST',
    path: ROUTES.enrol,
    body: { token, receiveKey: receive },
    at: clock,
  })

async function enrolled(): Promise<void> {
  const token = await store.issueToken(clock)
  expect((await enrol(device, token, deviceReceive)).status).toBe(204)
}

const open = async (): Promise<string> => {
  const opened = await call(base, device, { method: 'POST', path: ROUTES.pairings, at: clock })
  expect(opened.status).toBe(201)
  return (opened.json as { pairing: string }).pairing
}

const joinAs = (who: Identity, pairing: string, receive = receiveKey()) =>
  call(base, who, {
    method: 'POST',
    path: `${ROUTES.pairings}/${pairing}/viewer`,
    body: { receiveKey: receive },
    at: clock,
  })

const confirm = (pairing: string) =>
  call(base, device, { method: 'POST', path: `${ROUTES.pairings}/${pairing}/confirm`, at: clock })

const fetchAs = (who: Identity) =>
  call(base, who, { method: 'GET', path: ROUTES.envelopes, at: clock })

describe('the check-in device, enrolled by the household’s token', () => {
  it('enrols the device that redeems it, and lets it open a pairing', async () => {
    await enrolled()
    await open()
  })

  it('redeems a token once', async () => {
    const token = await store.issueToken(clock)
    expect((await enrol(device, token)).status).toBe(204)
    expect(await enrol(identity(), token)).toEqual({
      status: 401,
      json: { error: 'not a token here' },
    })
  })

  it('enrols no second device, whatever token it brings (#45 replaces one)', async () => {
    await enrolled()
    const another = await store.issueToken(clock)
    expect(await enrol(identity(), another)).toEqual({
      status: 409,
      json: { error: 'a check-in device is enrolled' },
    })
  })

  it('refuses a token past its 15 minutes', async () => {
    const token = await store.issueToken(clock)
    clock += ENROL_TOKEN_TTL_MS
    expect((await enrol(device, token)).status).toBe(401)
  })

  it('refuses a token it never issued', async () => {
    expect((await enrol(device, 'A'.repeat(22))).status).toBe(401)
  })

  it('keeps no token in its file, only its hash', async () => {
    const token = await store.issueToken(clock)
    expect(await readFile(join(dir, 'relay.json'), 'utf8')).not.toContain(token)
  })
})

describe('a viewer, enrolled by a pairing the device confirms (KV-31)', () => {
  it('passes the keys both ways, and enrols only on the device’s confirmation', async () => {
    await enrolled()
    const pairing = await open()
    const ann = identity()
    const annReceive = receiveKey()
    // The viewer gets the device's two keys, for its half of the code (#40).
    expect(await joinAs(ann, pairing, annReceive)).toEqual({
      status: 200,
      json: { device: { key: device.key, receiveKey: deviceReceive } },
    })
    // The device gets the viewer's two, for its half.
    const seen = await call(base, device, {
      method: 'GET',
      path: `${ROUTES.pairings}/${pairing}`,
      at: clock,
    })
    expect(seen.status).toBe(200)
    expect((seen.json as { viewer: unknown }).viewer).toEqual({
      key: ann.key,
      receiveKey: annReceive,
    })
    // Joined is not enrolled: nothing until the codes matched and the device said so.
    expect((await fetchAs(ann)).status).toBe(401)
    expect((await confirm(pairing)).status).toBe(204)
    expect((await fetchAs(ann)).status).toBe(200)
    const gone = await call(base, device, {
      method: 'GET',
      path: `${ROUTES.pairings}/${pairing}`,
      at: clock,
    })
    expect(gone.status).toBe(404)
  })

  it('takes one viewer per pairing', async () => {
    await enrolled()
    const pairing = await open()
    expect((await joinAs(identity(), pairing)).status).toBe(200)
    expect(await joinAs(identity(), pairing)).toEqual({
      status: 409,
      json: { error: 'someone joined it already' },
    })
  })

  it('enrols nobody from a pairing never confirmed, once it expires', async () => {
    await enrolled()
    const pairing = await open()
    const ann = identity()
    await joinAs(ann, pairing)
    clock += PAIRING_TTL_MS
    expect((await confirm(pairing)).status).toBe(404)
    expect((await fetchAs(ann)).status).toBe(401)
  })

  it('refuses to confirm a pairing nobody joined', async () => {
    await enrolled()
    const pairing = await open()
    expect(await confirm(pairing)).toEqual({
      status: 409,
      json: { error: 'nobody has joined it' },
    })
  })

  it('closes a pairing the device cancels', async () => {
    await enrolled()
    const pairing = await open()
    const closed = await call(base, device, {
      method: 'DELETE',
      path: `${ROUTES.pairings}/${pairing}`,
      at: clock,
    })
    expect(closed.status).toBe(204)
    expect((await joinAs(identity(), pairing)).status).toBe(404)
  })

  it('closes the last pairing when another opens: one at a time', async () => {
    await enrolled()
    const first = await open()
    await open()
    expect((await joinAs(identity(), first)).status).toBe(404)
  })

  it('approves again a viewer whose sharing ended, by a new pairing', async () => {
    await enrolled()
    const ann = identity()
    const first = await open()
    await joinAs(ann, first)
    await confirm(first)
    await call(base, device, { method: 'DELETE', path: ROUTES.viewers + ann.key, at: clock })
    expect(await fetchAs(ann)).toEqual({ status: 410, json: ENDED })
    const second = await open()
    expect((await joinAs(ann, second)).status).toBe(200)
    expect((await confirm(second)).status).toBe(204)
    expect((await fetchAs(ann)).status).toBe(200)
  })

  it('refuses to join with the device’s key, or a viewer’s already enrolled', async () => {
    await enrolled()
    const ann = identity()
    const first = await open()
    await joinAs(ann, first)
    await confirm(first)
    const second = await open()
    expect((await joinAs(device, second)).status).toBe(409)
    expect((await joinAs(ann, second)).status).toBe(409)
  })

  it('lets only the device open, read, confirm and close a pairing', async () => {
    await enrolled()
    const ann = identity()
    const first = await open()
    await joinAs(ann, first)
    await confirm(first)
    const pairing = await open()
    const asAnn = (method: string, path: string) => call(base, ann, { method, path, at: clock })
    expect((await asAnn('POST', ROUTES.pairings)).status).toBe(403)
    expect((await asAnn('GET', `${ROUTES.pairings}/${pairing}`)).status).toBe(403)
    expect((await asAnn('POST', `${ROUTES.pairings}/${pairing}/confirm`)).status).toBe(403)
    expect((await asAnn('DELETE', `${ROUTES.pairings}/${pairing}`)).status).toBe(403)
  })

  it('finds no pairing to join before a device is enrolled', async () => {
    expect((await joinAs(identity(), 'ABCDEFGHJK')).status).toBe(404)
  })
})

describe('what a stranger can reach', () => {
  it(`refuses an address after ${MAX_FAILED_ATTEMPTS} failures, until the window passes`, async () => {
    // Guessing pairing ids, or tokens. A real one is refused too once the address is: the
    // limit is on the address, not on whether the next guess happens to be right.
    await enrolled()
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      expect((await joinAs(identity(), 'ABCDEFGHJK')).status).toBe(404)
    }
    const pairing = await open()
    expect(await joinAs(identity(), pairing)).toEqual({
      status: 429,
      json: { error: 'too many attempts' },
    })
    clock += ATTEMPT_WINDOW_MS
    // The pairing expired with the window; a new one is what the device would show.
    expect((await joinAs(identity(), await open())).status).toBe(200)
  })

  it('counts no attempt that succeeded, and none on the signed routes', async () => {
    await enrolled()
    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i += 1) {
      expect((await fetchAs(identity())).status).toBe(401)
    }
    expect((await joinAs(identity(), await open())).status).toBe(200)
  })
})

describe('a mailbox’s ceiling', () => {
  it(`takes ${MAX_WAITING_PER_VIEWER} envelopes for a viewer, and refuses the next`, async () => {
    await enrolled()
    const ann = identity()
    const pairing = await open()
    await joinAs(ann, pairing)
    await confirm(pairing)
    for (let from = 1; from <= MAX_WAITING_PER_VIEWER; from += MAX_ENVELOPES_PER_POST) {
      const envelopes = Array.from({ length: MAX_ENVELOPES_PER_POST }, (_, i) => ({
        viewer: ann.key,
        stream: from + i,
        sealed: sealed(`s${from + i}`),
      }))
      const posted = await call(base, device, {
        method: 'POST',
        path: ROUTES.envelopes,
        body: { envelopes },
        at: clock,
      })
      expect(posted.status).toBe(200)
    }
    const over = await call(base, device, {
      method: 'POST',
      path: ROUTES.envelopes,
      body: { envelopes: [{ viewer: ann.key, stream: MAX_WAITING_PER_VIEWER + 1, sealed: 'x' }] },
      at: clock,
    })
    expect(over).toEqual({ status: 507, json: { error: 'a mailbox is full' } })
    const mailbox = (await fetchAs(ann)).json as { envelopes: unknown[] }
    expect(mailbox.envelopes).toHaveLength(MAX_WAITING_PER_VIEWER)
  })
})

describe('the log', () => {
  it('records method, route, status and time, and no key, token, id or byte sent', async () => {
    const token = await store.issueToken(clock)
    await enrol(device, token, deviceReceive)
    const ann = identity()
    const pairing = await open()
    await joinAs(ann, pairing)
    await confirm(pairing)
    await call(base, device, {
      method: 'POST',
      path: ROUTES.envelopes,
      body: { envelopes: [{ viewer: ann.key, stream: 1, sealed: sealed('a reading') }] },
      at: clock,
    })
    await fetchAs(ann)
    await call(base, device, { method: 'DELETE', path: ROUTES.viewers + ann.key, at: clock })
    const text = JSON.stringify(logged)
    const secrets = [device.key, deviceReceive, ann.key, token, pairing, sealed('a reading')]
    for (const secret of secrets) {
      expect(text).not.toContain(secret)
    }
    expect(logged.map((entry) => entry.route)).toEqual([
      ROUTES.enrol,
      ROUTES.pairings,
      `${ROUTES.pairings}/:pairing/viewer`,
      `${ROUTES.pairings}/:pairing/confirm`,
      ROUTES.envelopes,
      ROUTES.envelopes,
      `${ROUTES.viewers}:viewer`,
    ])
    expect(Object.keys(logged[0] ?? {}).sort()).toEqual(['method', 'ms', 'route', 'status'])
  })

  it.each([
    ['/v1/envelopes', '/v1/envelopes'],
    ['/v1/viewers/anything', '/v1/viewers/:viewer'],
    ['/v1/pairings/ABCDEFGHJK', '/v1/pairings/:pairing'],
    ['/v1/pairings/ABCDEFGHJK/confirm', '/v1/pairings/:pairing/confirm'],
    ['/v1/somewhere/else', 'unknown'],
  ])('names %s as %s', (path, route) => {
    expect(routeOf(path)).toBe(route)
  })
})
