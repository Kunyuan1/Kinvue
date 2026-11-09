import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REQUEST_TIMEOUT_MS, ROUTES } from '@kinvue/core/sync/protocol'
import {
  createRelayServer,
  HEADERS_TIMEOUT_MS,
  MAX_CONNECTIONS,
  type LogEntry,
} from '../server'
import { createRelayStore } from '../store'
import { listening } from './helpers'

/**
 * The relay over HTTPS, the only way it may listen off loopback (reviews of #219). With a
 * self-signed certificate for localhost, valid to 2126, kept under `fixtures/` for this
 * alone: its key is published, so it secures nothing.
 */

const fixture = (name: string) => readFile(join(__dirname, 'fixtures', name))

let dir: string
let server: Server
let base: string
let logged: LogEntry[]
let cert: Buffer

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kinvue-relay-tls-'))
  cert = await fixture('tls-cert.pem')
  logged = []
  server = createRelayServer({
    store: createRelayStore(join(dir, 'relay.json')),
    tls: { cert, key: await fixture('tls-key.pem') },
    log: (entry) => logged.push(entry),
  })
  base = await listening(server)
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

/** A GET over HTTPS that trusts the fixture's certificate, and its status. */
const getOverTls = (path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const { port } = new URL(base)
    request({ host: '127.0.0.1', port, path, ca: cert, servername: 'localhost' }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })

describe('the relay over HTTPS', () => {
  it('answers over TLS, and logs the request', async () => {
    // Unsigned, so 401: what matters is that it was HTTPS that answered it.
    expect(await getOverTls(ROUTES.envelopes)).toBe(401)
    expect(logged).toMatchObject([{ method: 'GET', route: ROUTES.envelopes, status: 401 }])
  })

  it('logs plain HTTP sent to it, which never reaches clientError', async () => {
    const { port } = new URL(base)
    await fetch(`http://127.0.0.1:${port}${ROUTES.envelopes}`).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(logged).toMatchObject([{ method: '', route: 'unknown', status: 400 }])
  })

  it('keeps every limit the HTTP server has', () => {
    // An HTTPS server built with options in the wrong order would pass the type check by
    // the cast; these are what it would lose.
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS)
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS)
    expect(server.maxConnections).toBe(MAX_CONNECTIONS)
  })
})
