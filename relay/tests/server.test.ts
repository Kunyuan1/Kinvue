import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENDED, REQUEST_WINDOW_MS, ROUTES } from '@kinvue/core/sync/protocol'
import { createRelayServer, MAX_BODY_BYTES } from '../server'
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
const device = identity()
const ann = identity()
const bill = identity()
const stranger = identity()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kinvue-relay-'))
  store = createRelayStore(join(dir, 'relay.json'))
  clock = Date.now()
  await store.enrolDevice(device.key, clock)
  await store.enrolViewer(ann.key, receiveKey(), clock)
  await store.enrolViewer(bill.key, receiveKey(), clock)
  server = createRelayServer({ store, now: () => clock })
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

describe('store and forward', () => {
  it('delivers what the device posts to the viewer it was sealed to', async () => {
    const posted = await post([
      { viewer: ann.key, stream: 1, sealed: sealed('one') },
      { viewer: ann.key, stream: 2, sealed: sealed('two') },
    ])
    expect(posted).toEqual({ status: 200, json: { added: 2 } })
    const mailbox = await fetchAs(ann)
    expect(mailbox.status).toBe(200)
    expect((mailbox.json as { envelopes: { stream: number }[] }).envelopes.map((e) => e.stream))
      .toEqual([1, 2])
  })

  it('never shows one viewer what waits for another (KV-31)', async () => {
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('for ann') }])
    expect(await fetchAs(bill)).toEqual({ status: 200, json: { envelopes: [] } })
  })

  it('records each fetch, and gives the device those times (KV-31)', async () => {
    await fetchAs(ann)
    clock += 1000
    await fetchAs(ann)
    const deliveries = await call(base, device, { method: 'GET', path: ROUTES.deliveries })
    expect(deliveries.status).toBe(200)
    const viewers = (deliveries.json as { viewers: { viewer: string; fetchedAt: number[] }[] })
      .viewers
    expect(viewers.find((v) => v.viewer === ann.key)?.fetchedAt).toEqual([clock - 1000, clock])
    expect(viewers.find((v) => v.viewer === bill.key)?.fetchedAt).toEqual([])
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
    // The outbox sending stream 1 again (#41) is harmless: it is held already.
    expect(await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])).toEqual({
      status: 200,
      json: { added: 0 },
    })
  })

  it('takes the same envelope twice as one', async () => {
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])
    expect((await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])).json).toEqual({
      added: 0,
    })
  })

  it('refuses different bytes at a stream it holds, and writes none of the batch', async () => {
    await post([{ viewer: ann.key, stream: 1, sealed: sealed('one') }])
    const clash = await post([
      { viewer: bill.key, stream: 1, sealed: sealed('for bill') },
      { viewer: ann.key, stream: 1, sealed: sealed('other') },
    ])
    expect(clash.status).toBe(409)
    expect(await fetchAs(bill)).toEqual({ status: 200, json: { envelopes: [] } })
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

  it('refuses a body over the limit, and says so', async () => {
    const big = 'a'.repeat(MAX_BODY_BYTES + 1)
    const res = await fetch(base + ROUTES.envelopes, { method: 'POST', body: big })
    expect(res.status).toBe(413)
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
