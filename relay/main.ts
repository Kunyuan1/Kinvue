import { readFile, open, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { ENROL_TOKEN_TTL_MS } from '@kinvue/core/sync/protocol'
import { createRelayServer } from './server'
import { createRelayStore, DeviceEnrolledError } from './store'

/**
 * Running the household's relay (KV-39): `npm run relay`, configured from the
 * environment, and nothing more to it than that.
 *
 * - **Plain HTTP on loopback only.** Anywhere else it needs a certificate, or it refuses
 *   to start: a relay reachable from the internet without TLS would show every request's
 *   metadata to the network between, and nothing about it would look wrong. On loopback, a
 *   reverse proxy in front of it — the household's choice, set up as #46 says — terminates
 *   TLS instead.
 * - **The check-in device's token is printed at start**, while no device is enrolled. Not a
 *   separate command: the store assumes one process owns its file, so a second one writing
 *   a token while the relay ran would have it overwritten by the relay's next change. A
 *   token lasts `ENROL_TOKEN_TTL_MS`; restarting prints another.
 * - **One relay per file.** A lock beside the file says which process holds it, so a
 *   second relay started on the same file refuses rather than overwriting the first's.
 * - **Its log is one JSON line a request** on standard output — method, route, status,
 *   time; never a key, a body or an address (`relay/server.ts`).
 */

/** Where the relay keeps its file, and where it listens. */
export interface RelayConfig {
  dataFile: string
  host: string
  port: number
  tls: { certFile: string; keyFile: string } | null
}

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** Whether `host` is this machine only. */
const isLoopback = (host: string): boolean =>
  LOOPBACK.has(host) || (isIP(host) === 4 && host.startsWith('127.'))

/**
 * The relay's configuration from `env`, or what is wrong with it, said so a household can
 * fix it:
 *
 * - `KINVUE_RELAY_DATA`: the file it keeps. Required: where a household's relay keeps its
 *   state is a choice it makes, not a default it finds later.
 * - `KINVUE_RELAY_HOST`, `KINVUE_RELAY_PORT`: where it listens; 127.0.0.1:8787 unless set.
 * - `KINVUE_RELAY_TLS_CERT`, `KINVUE_RELAY_TLS_KEY`: its certificate and key, PEM files.
 *   Both or neither; required off loopback.
 */
export function configFrom(env: Record<string, string | undefined>): RelayConfig | string {
  const dataFile = env.KINVUE_RELAY_DATA
  if (dataFile === undefined || dataFile === '') {
    return (
      'Set KINVUE_RELAY_DATA to the file the relay keeps, for example ' +
      '/var/lib/kinvue/relay.json.'
    )
  }
  const host = env.KINVUE_RELAY_HOST ?? DEFAULT_HOST
  const portText = env.KINVUE_RELAY_PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return `KINVUE_RELAY_PORT is ${portText}, not a port.`
  }
  const certFile = env.KINVUE_RELAY_TLS_CERT
  const keyFile = env.KINVUE_RELAY_TLS_KEY
  if ((certFile === undefined) !== (keyFile === undefined)) {
    return 'Set both KINVUE_RELAY_TLS_CERT and KINVUE_RELAY_TLS_KEY, or neither.'
  }
  const tls = certFile !== undefined && keyFile !== undefined ? { certFile, keyFile } : null
  if (tls === null && !isLoopback(host)) {
    return (
      `KINVUE_RELAY_HOST is ${host}, which is not this machine only, and there is no ` +
      'certificate. Set KINVUE_RELAY_TLS_CERT and KINVUE_RELAY_TLS_KEY, or listen on ' +
      '127.0.0.1 behind a reverse proxy that serves HTTPS.'
    )
  }
  return { dataFile, host, port, tls }
}

/** Another relay holds this file. */
export class RelayLockedError extends Error {}

/**
 * Takes the lock beside `dataFile` for this process, or refuses. A lock left by a process
 * that is no longer running — a crash, a power cut — is taken over, since nothing holds it.
 */
async function lock(dataFile: string): Promise<() => Promise<void>> {
  const path = `${dataFile}.lock`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(String(process.pid), 'utf8')
      await handle.close()
      return () => rm(path, { force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const pid = Number(await readFile(path, 'utf8').catch(() => ''))
      if (Number.isInteger(pid) && pid > 0 && running(pid)) {
        throw new RelayLockedError(
          `Another relay (process ${pid}) is using ${dataFile}. Stop it first; two relays on ` +
            'one file would overwrite each other.',
        )
      }
      await rm(path, { force: true })
    }
  }
  throw new RelayLockedError(`Could not take the lock beside ${dataFile}.`)
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it runs, as someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface Running {
  /** Where it listens, as the device and viewers would reach it. */
  url: string
  /** Stops listening, finishes what is in flight, and lets go of the file. */
  close: () => Promise<void>
}

/**
 * Starts the relay: takes the file's lock, reads the file (a file it cannot read stops it
 * here, before it listens), prints a token if no device is enrolled, and listens. `say` is
 * where its lines go: the token, where it listens, and the log.
 */
export async function startRelay(
  config: RelayConfig,
  say: (line: string) => void,
  now: () => number = Date.now,
): Promise<Running> {
  const unlock = await lock(config.dataFile)
  try {
    const store = createRelayStore(config.dataFile)
    try {
      const token = await store.issueToken(now())
      const minutes = ENROL_TOKEN_TTL_MS / 60_000
      say(`No check-in device is enrolled. Its one-time token, for the next ${minutes} minutes:`)
      say(`  ${token}`)
    } catch (err) {
      if (!(err instanceof DeviceEnrolledError)) throw err
      say('A check-in device is enrolled.')
    }
    const tls =
      config.tls === null
        ? undefined
        : {
            cert: await readFile(config.tls.certFile),
            key: await readFile(config.tls.keyFile),
          }
    const server = createRelayServer({
      store,
      now,
      tls,
      log: (entry) => say(JSON.stringify(entry)),
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const { port } = server.address() as AddressInfo
    const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host
    const url = `${tls === undefined ? 'http' : 'https'}://${host}:${port}`
    say(`The relay is listening at ${url}.`)
    return {
      url,
      close: async () => {
        await new Promise((resolve) => server.close(resolve))
        await unlock()
      },
    }
  } catch (err) {
    await unlock()
    throw err
  }
}

/** `node main.js start`: the relay, until it is stopped. */
async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  if (command !== 'start') {
    process.stderr.write('Usage: npm run relay  (which runs: node relay/dist/main.js start)\n')
    process.exitCode = 2
    return
  }
  const config = configFrom(process.env)
  if (typeof config === 'string') {
    process.stderr.write(`${config}\n`)
    process.exitCode = 1
    return
  }
  const relay = await startRelay(config, (line) => process.stdout.write(`${line}\n`))
  const stop = (): void => {
    void relay.close().then(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

// Run only as the program, not when a test imports this file.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
