import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROUTES } from '@kinvue/core/sync/protocol'
import {
  bootedAt,
  configFrom,
  DEFAULT_HOST,
  DEFAULT_PORT,
  RelayLockedError,
  startRelay,
  type Output,
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

  it('refuses a relative path to the file (reviews of #219)', () => {
    expect(configFrom({ KINVUE_RELAY_DATA: './relay-data/relay.json' })).toMatch(/relative/)
    expect(configFrom({ KINVUE_RELAY_DATA: 'relay.json' })).toMatch(/relative/)
  })

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

  it.each(['eighty', '-1', '65536', '80.5', '0', '0x1f90', '1e3', ' 8787'])(
    'refuses port %j',
    (port) => {
      expect(configFrom({ ...data, KINVUE_RELAY_PORT: port })).toMatch(/not a port/)
    },
  )

  it.each([
    'KINVUE_RELAY_DATA',
    'KINVUE_RELAY_HOST',
    'KINVUE_RELAY_PORT',
    'KINVUE_RELAY_TLS_CERT',
    'KINVUE_RELAY_TLS_KEY',
  ])('refuses %s set but empty (review of #219)', (name) => {
    expect(configFrom({ ...data, [name]: '' })).toBe(
      `${name} is set but empty. Give it a value, or unset it.`,
    )
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

  /** Everything the relay says, log and person alike; the token shown, as at a terminal. */
  const output = (showToken = true): Output => ({
    log: (line) => said.push(line),
    tell: (line) => said.push(line),
    showToken,
  })

  const start = async (showToken = true): Promise<Running> => {
    const relay = await startRelay(config, output(showToken))
    running.push(relay)
    return relay
  }

  const tokenFile = () => `${config.dataFile}.token`
  const shownToken = () => said.find((line) => /^ {2}\S{22}$/.test(line))?.trim()

  it('prints a token while no device is enrolled, and that token enrols one', async () => {
    const relay = await start()
    const token = shownToken()
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
    expect(shownToken()).toBeUndefined()
    // Used, its file goes too.
    await expect(readFile(tokenFile(), 'utf8')).rejects.toThrow()
  })

  it('writes the token beside the data, and logs only its path (reviews of #219)', async () => {
    // Standard output and error both end in the journal under systemd; a credential there
    // outlives its use and is readable by whoever reads logs.
    await start(false)
    const token = (await readFile(tokenFile(), 'utf8')).trim()
    expect(token).toMatch(/^\S{22}$/)
    expect(said.join('\n')).not.toContain(token)
    expect(said.some((line) => line.includes(tokenFile()))).toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(tokenFile())).mode & 0o777).toBe(0o600)
    }
  })

  it('shows the token itself only at a terminal', async () => {
    await start(true)
    expect(shownToken()).toBe((await readFile(tokenFile(), 'utf8')).trim())
  })

  it('issues no token for a relay that never listened (reviews of #219)', async () => {
    // A port already taken: the second relay cannot listen, so it must not have written a
    // token into its file, or said one, on the way to failing.
    const taken = await start()
    const port = Number(new URL(taken.url).port)
    const other = { ...config, dataFile: join(dir, 'other.json'), port }
    said = []
    await expect(startRelay(other, output())).rejects.toThrow()
    await expect(readFile(other.dataFile, 'utf8')).rejects.toThrow()
    await expect(readFile(`${other.dataFile}.token`, 'utf8')).rejects.toThrow()
    expect(shownToken()).toBeUndefined()
  })

  it('issues a token on demand, voiding the last (review of #219)', async () => {
    const relay = await start()
    const first = shownToken()
    said = []
    await relay.issueToken()
    const second = shownToken()
    expect(second).not.toBe(first)
    expect((await readFile(tokenFile(), 'utf8')).trim()).toBe(second)
    const enrolWith = (token: string | undefined) =>
      call(relay.url, identity(), {
        method: 'POST',
        path: ROUTES.enrol,
        body: { token, receiveKey: receiveKey() },
      })
    expect((await enrolWith(first)).status).toBe(401)
    expect((await enrolWith(second)).status).toBe(204)
  })

  it('says a wildcard listens everywhere, and gives an address this machine can use', async () => {
    const relay = await startRelay({ ...config, host: '0.0.0.0' }, output())
    running.push(relay)
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(said.some((line) => /listening on every address, port \d+/.test(line))).toBe(true)
    expect((await fetch(relay.url + ROUTES.envelopes)).status).toBe(401)
  })

  it('serves HTTPS given a certificate, and says so in its address (review of #219)', async () => {
    const fixtures = join(__dirname, 'fixtures')
    const tls = {
      certFile: join(fixtures, 'tls-cert.pem'),
      keyFile: join(fixtures, 'tls-key.pem'),
    }
    const relay = await startRelay({ ...config, tls }, output())
    running.push(relay)
    expect(relay.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/)
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
    await expect(startRelay(config, output())).rejects.toBeInstanceOf(RelayLockedError)
  })

  const lockPath = () => `${config.dataFile}.lock`
  const holder = (pid: number, at = bootedAt(Date.now())) => JSON.stringify({ pid, bootedAt: at })
  const heldBy = async () => JSON.parse(await readFile(lockPath(), 'utf8')) as { pid: number }

  it('takes over a lock left by a relay that is no longer running', async () => {
    // A process id nothing has: a relay that crashed.
    await writeFile(lockPath(), holder(999_999_999), 'utf8')
    const relay = await start()
    expect((await heldBy()).pid).toBe(process.pid)
    await relay.close()
    running = []
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow()
  })

  it('takes over a lock from before this boot, whatever its pid names (#219)', async () => {
    // A power cut: the pid in the lock was handed to another process after the reboot.
    // This test's own parent stands in for it: running, and no relay.
    const lastBoot = bootedAt(Date.now()) - 24 * 60 * 60 * 1000
    await writeFile(lockPath(), holder(process.ppid, lastBoot), 'utf8')
    await start()
    expect((await heldBy()).pid).toBe(process.pid)
  })

  it('refuses a lock from this boot whose holder runs, and says what to do', async () => {
    await writeFile(lockPath(), holder(process.ppid), 'utf8')
    await expect(start()).rejects.toThrow(/Another relay .*If no relay is running/)
    await expect(start()).rejects.not.toThrow(/Stop it/)
  })

  it.each([
    ['empty', ''],
    ['not saying who', 'nobody'],
  ])('reads a lock that is %s as held, never as stale (reviews of #219)', async (_what, text) => {
    // An empty lock is what a second relay saw while the first was still writing its pid,
    // and took over: two relays on one file.
    await writeFile(lockPath(), text, 'utf8')
    await expect(start()).rejects.toBeInstanceOf(RelayLockedError)
    expect(await readFile(lockPath(), 'utf8')).toBe(text)
  })

  it('lets go only of its own lock, not one a successor took (review of #219)', async () => {
    const relay = await start()
    await writeFile(lockPath(), holder(process.ppid), 'utf8')
    await relay.close()
    running = []
    expect((await heldBy()).pid).toBe(process.ppid)
  })

  it('stops before listening on a file it cannot read, and lets go of the lock', async () => {
    await writeFile(config.dataFile, 'not a relay file', 'utf8')
    await expect(start()).rejects.toThrow(/not JSON/)
    await expect(readFile(`${config.dataFile}.lock`, 'utf8')).rejects.toThrow()
  })
})
