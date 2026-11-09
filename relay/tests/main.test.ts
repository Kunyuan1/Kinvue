import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROUTES } from '@kinvue/core/sync/protocol'
import {
  configFrom,
  DEFAULT_HOST,
  DEFAULT_PORT,
  RelayLockedError,
  startRelay,
  type RelayConfig,
  type Running,
} from '../main'
import { call, identity, receiveKey } from './helpers'

/**
 * Running the relay (KV-39): its configuration, and starting it, in-process. The built
 * bundle as its own process is checked by hand in the PR, against the same code.
 */

describe('the configuration', () => {
  const data = { KINVUE_RELAY_DATA: '/var/lib/kinvue/relay.json' }

  it('needs the file named, and listens on loopback by default', () => {
    expect(configFrom({})).toMatch(/KINVUE_RELAY_DATA/)
    expect(configFrom(data)).toEqual({
      dataFile: data.KINVUE_RELAY_DATA,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      tls: null,
    })
  })

  it.each(['0.0.0.0', '::', '192.168.1.20', 'relay.example.org'])(
    'refuses %s without a certificate',
    (host) => {
      expect(configFrom({ ...data, KINVUE_RELAY_HOST: host })).toMatch(/no certificate/)
    },
  )

  it.each(['127.0.0.1', '127.0.0.2', '::1', 'localhost'])('allows %s without one', (host) => {
    expect(configFrom({ ...data, KINVUE_RELAY_HOST: host })).toMatchObject({ host, tls: null })
  })

  it('listens anywhere with a certificate and its key', () => {
    const tls = { KINVUE_RELAY_TLS_CERT: 'cert.pem', KINVUE_RELAY_TLS_KEY: 'key.pem' }
    expect(configFrom({ ...data, ...tls, KINVUE_RELAY_HOST: '0.0.0.0' })).toMatchObject({
      tls: { certFile: 'cert.pem', keyFile: 'key.pem' },
    })
  })

  it('refuses one of the two without the other', () => {
    expect(configFrom({ ...data, KINVUE_RELAY_TLS_CERT: 'cert.pem' })).toMatch(/both/)
    expect(configFrom({ ...data, KINVUE_RELAY_TLS_KEY: 'key.pem' })).toMatch(/both/)
  })

  it.each(['eighty', '-1', '65536', '80.5'])('refuses port %s', (port) => {
    expect(configFrom({ ...data, KINVUE_RELAY_PORT: port })).toMatch(/not a port/)
  })
})

describe('starting it', () => {
  let dir: string
  let config: RelayConfig
  let running: Running[]
  let said: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kinvue-relay-main-'))
    config = { dataFile: join(dir, 'relay.json'), host: '127.0.0.1', port: 0, tls: null }
    running = []
    said = []
  })

  afterEach(async () => {
    for (const relay of running) await relay.close()
    await rm(dir, { recursive: true, force: true })
  })

  const start = async (): Promise<Running> => {
    const relay = await startRelay(config, (line) => said.push(line))
    running.push(relay)
    return relay
  }

  it('prints a token while no device is enrolled, and that token enrols one', async () => {
    const relay = await start()
    const token = said.find((line) => /^ {2}\S{22}$/.test(line))?.trim()
    expect(token).toBeDefined()
    const device = identity()
    const enrol = await call(relay.url, device, {
      method: 'POST',
      path: ROUTES.enrol,
      body: { token, receiveKey: receiveKey() },
    })
    expect(enrol.status).toBe(204)
    await relay.close()
    running = []
    said = []
    await start()
    expect(said).toContain('A check-in device is enrolled.')
    expect(said.some((line) => /^ {2}\S{22}$/.test(line))).toBe(false)
  })

  it('says where it listens', async () => {
    const relay = await start()
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(said).toContain(`The relay is listening at ${relay.url}.`)
  })

  it('logs each request as one line of JSON', async () => {
    const relay = await start()
    await fetch(relay.url + ROUTES.envelopes)
    const lines = said.filter((line) => line.startsWith('{'))
    expect(lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
      { method: 'GET', route: ROUTES.envelopes, status: 401 },
    ])
  })

  it('refuses a second relay on the same file', async () => {
    await start()
    await expect(startRelay(config, () => undefined)).rejects.toBeInstanceOf(RelayLockedError)
  })

  it('takes over a lock left by a relay that is no longer running', async () => {
    // A process id nothing has: a relay that crashed, or a power cut.
    await writeFile(`${config.dataFile}.lock`, '999999999', 'utf8')
    const relay = await start()
    expect(await readFile(`${config.dataFile}.lock`, 'utf8')).toBe(String(process.pid))
    await relay.close()
    running = []
    await expect(readFile(`${config.dataFile}.lock`, 'utf8')).rejects.toThrow()
  })

  it('stops before listening on a file it cannot read, and lets go of the lock', async () => {
    await writeFile(config.dataFile, 'not a relay file', 'utf8')
    await expect(start()).rejects.toThrow(/not JSON/)
    await expect(readFile(`${config.dataFile}.lock`, 'utf8')).rejects.toThrow()
  })
})
