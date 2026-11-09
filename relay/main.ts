import { link, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { uptime } from 'node:os'
import { isAbsolute } from 'node:path'
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
  /**
   * From the environment, 1 to 65535 (`configFrom`). 0, which the system turns into a free
   * port, is for tests building a config directly (review of #219).
   */
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
  // Set but empty is refused, never read as unset or as zero (review of #219): it is how a
  // variable usually ends up empty, in an EnvironmentFile or a compose block, and read as
  // unset or 0 it would start a relay somewhere nobody meant.
  const named = [
    'KINVUE_RELAY_DATA',
    'KINVUE_RELAY_HOST',
    'KINVUE_RELAY_PORT',
    'KINVUE_RELAY_TLS_CERT',
    'KINVUE_RELAY_TLS_KEY',
  ]
  const empty = named.find((name) => env[name] === '')
  if (empty !== undefined) return `${empty} is set but empty. Give it a value, or unset it.`
  const dataFile = env.KINVUE_RELAY_DATA
  if (dataFile === undefined) {
    return (
      'Set KINVUE_RELAY_DATA to the file the relay keeps, for example ' +
      '/var/lib/kinvue/relay.json.'
    )
  }
  // Absolute only (reviews of #219): `npm run relay` runs in relay/ and `node
  // relay/dist/main.js` wherever it was typed, so one relative path would name two files —
  // and a relay finding the other one empty would print a fresh token beside the real keys.
  if (!isAbsolute(dataFile)) {
    return (
      `KINVUE_RELAY_DATA is ${dataFile}, a relative path, which names a different file ` +
      'depending on where the relay is started. Give it as an absolute path, for example ' +
      '/var/lib/kinvue/relay.json.'
    )
  }
  const host = env.KINVUE_RELAY_HOST ?? DEFAULT_HOST
  const portText = env.KINVUE_RELAY_PORT ?? String(DEFAULT_PORT)
  // Digits only, 1 to 65535: `Number` would read 0x1f90 as 8080 and 1e3 as 1000, and 0 as
  // a port the system picks, different every start (review of #219).
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN
  if (!(port >= 1 && port <= 65535)) {
    return `KINVUE_RELAY_PORT is ${portText}, not a port from 1 to 65535.`
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

/** Another relay holds this file, or might. */
export class RelayLockedError extends Error {}

/** What a lock says about who holds it. */
export interface Holder {
  pid: number
  /** When the machine the holder ran on last booted, in milliseconds. */
  bootedAt: number
}

/** How far two readings of one boot's time may differ: `uptime` is whole seconds. */
const BOOT_SLACK_MS = 60 * 1000

/** When this machine booted, by `now`. */
export const bootedAt = (now: number): number => now - uptime() * 1000

const holderIn = (text: string | null): Holder | null => {
  try {
    const held = JSON.parse(text ?? '') as Partial<Holder>
    const { pid, bootedAt: at } = held
    return Number.isInteger(pid) && (pid as number) > 0 && Number.isFinite(at)
      ? { pid: pid as number, bootedAt: at as number }
      : null
  } catch {
    return null
  }
}

/**
 * Whether `held` holds nothing any longer: written before this machine last booted — a
 * power cut, a reboot — whatever its pid now names, since a pid means something only
 * within one boot; or by a process no longer running (reviews of #219).
 */
const stale = (held: Holder, now: number): boolean =>
  Math.abs(held.bootedAt - bootedAt(now)) > BOOT_SLACK_MS || !running(held.pid)

/**
 * Takes the lock beside `dataFile` for this process, or refuses (reviews of #219).
 *
 * - **It exists only once it names its holder.** The holder is written to a file of its
 *   own and linked into place, and `link` fails if the lock is there: there is no moment
 *   when the lock is there and empty, for a second relay to read as nobody's.
 * - **A lock that does not say who holds it is held**, never stale: refused, with what to
 *   do. Guessing it was nobody's is how two relays come to share a file.
 * - **A stale lock is taken over**, by moving it aside under a name of this process's own
 *   and checking that what moved is what was judged stale; anything else is put back.
 *
 * Returns what lets go of it, which removes the lock only while it still names this relay.
 */
async function lock(dataFile: string, now: () => number): Promise<() => Promise<void>> {
  const path = `${dataFile}.lock`
  const mine = JSON.stringify({ pid: process.pid, bootedAt: bootedAt(now()) } satisfies Holder)
  const ours = `${path}.${process.pid}`
  const aside = `${path}.stale.${process.pid}`
  const ifUnheld = `If no relay is running on ${dataFile}, delete ${path} and start again.`
  await writeFile(ours, mine, 'utf8')
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(ours, path)
        return async () => {
          if ((await readFile(path, 'utf8').catch(() => null)) === mine) await rm(path)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      const text = await readFile(path, 'utf8').catch(() => null)
      const held = holderIn(text)
      if (held === null) {
        throw new RelayLockedError(`${path} does not say which relay holds it. ${ifUnheld}`)
      }
      if (!stale(held, now())) {
        throw new RelayLockedError(
          `Another relay (process ${held.pid}) holds ${path}; two relays on one file would ` +
            `overwrite each other. ${ifUnheld}`,
        )
      }
      await rename(path, aside).catch(() => undefined)
      const moved = await readFile(aside, 'utf8').catch(() => null)
      if (moved !== null && moved !== text) {
        // Someone else's fresh lock, taken in between: theirs, so it goes back.
        await link(aside, path).catch(() => undefined)
        await rm(aside, { force: true })
        throw new RelayLockedError(`Another relay took ${path} as this one started. ${ifUnheld}`)
      }
      await rm(aside, { force: true })
    }
    throw new RelayLockedError(`Could not take ${path}. ${ifUnheld}`)
  } finally {
    await rm(ours, { force: true })
  }
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
  /**
   * Where this machine reaches it. For a host that is one address, also where the device
   * and viewers would; for a wildcard (`0.0.0.0`, `::`), loopback, since the wildcard
   * itself is not an address anything can reach (reviews of #219).
   */
  url: string
  /** A new one-time token for the check-in device, as at start; voids any earlier one. */
  issueToken: () => Promise<void>
  /** Stops listening, finishes what is in flight, and lets go of the file. */
  close: () => Promise<void>
}

/** Where the relay's lines go. */
export interface Output {
  /** One JSON line a request: method, route, status, time. Standard output, in `main`. */
  log: (line: string) => void
  /** What a person running it should know. Standard error, in `main`. */
  tell: (line: string) => void
  /**
   * Whether the token itself may be shown, beside the file it is written to: only when a
   * person is at a terminal, never into a log (reviews of #219).
   */
  showToken: boolean
}

const WILDCARDS = new Set(['0.0.0.0', '::'])

/** How long `close` waits for requests in flight before cutting them off. */
export const CLOSE_GRACE_MS = 10 * 1000

/**
 * Starts the relay: takes the file's lock, reads the file (a file it cannot read stops it
 * here, before anything else), listens, and only then — the relay known to be running —
 * gives the check-in device its token if none is enrolled (reviews of #219).
 *
 * **The token is written to a file beside the data file**, `<data>.token`, readable by the
 * relay's own user only, and the path is what is said. A token said on standard output or
 * error would land in the journal or a log file, kept long after it was used, and readable
 * by whoever reads logs. Shown as well only to a person at a terminal (`showToken`).
 */
export async function startRelay(
  config: RelayConfig,
  out: Output,
  now: () => number = Date.now,
): Promise<Running> {
  const unlock = await lock(config.dataFile, now)
  try {
    const store = createRelayStore(config.dataFile)
    // Read now, so a file it cannot read stops it before it listens.
    await store.roleOf('')
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
      log: (entry) => out.log(JSON.stringify(entry)),
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // Kept for the relay's life (reviews of #219): an accept that fails — out of file
    // descriptors, say — is said, and the relay goes on listening, rather than an
    // unhandled 'error' ending it with its lock behind.
    server.on('error', (err) => out.tell(`The relay could not take a connection: ${err.message}`))

    const { port } = server.address() as AddressInfo
    const scheme = tls === undefined ? 'http' : 'https'
    const wildcard = WILDCARDS.has(config.host)
    const reachable = wildcard ? '127.0.0.1' : config.host
    const host = isIP(reachable) === 6 ? `[${reachable}]` : reachable
    const url = `${scheme}://${host}:${port}`
    out.tell(
      wildcard
        ? `The relay is listening on every address, port ${port} (from this machine, ${url}).`
        : `The relay is listening at ${url}.`,
    )

    const tokenFile = `${config.dataFile}.token`
    const issueToken = async (): Promise<void> => {
      try {
        const token = await store.issueToken(now())
        await rm(tokenFile, { force: true })
        await writeFile(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
        const minutes = ENROL_TOKEN_TTL_MS / 60_000
        out.tell(
          `No check-in device is enrolled. Its one-time token, for the next ${minutes} ` +
            `minutes, is in ${tokenFile}, readable by this user only.`,
        )
        if (out.showToken) out.tell(`  ${token}`)
      } catch (err) {
        if (!(err instanceof DeviceEnrolledError)) throw err
        await rm(tokenFile, { force: true })
        out.tell('A check-in device is enrolled.')
      }
    }
    await issueToken()

    return {
      url,
      issueToken,
      close: async () => {
        const closed = new Promise<Error | undefined>((resolve) => server.close(resolve))
        // Requests still in flight after the grace are cut off, so a stop always ends.
        const grace = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS)
        grace.unref()
        const err = await closed
        clearTimeout(grace)
        await unlock()
        if (err !== undefined) throw err
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
    process.stderr.write(
      'Usage: node relay/dist/main.js start  (or, in a checkout: npm run relay)\n',
    )
    process.exitCode = 2
    return
  }
  const config = configFrom(process.env)
  if (typeof config === 'string') {
    process.stderr.write(`${config}\n`)
    process.exitCode = 1
    return
  }
  const relay = await startRelay(config, {
    log: (line) => process.stdout.write(`${line}\n`),
    tell: (line) => process.stderr.write(`${line}\n`),
    showToken: process.stderr.isTTY === true,
  })
  // Stopped once, however many signals arrive while it drains (reviews of #219); a close
  // that fails is said and exits non-zero. No `process.exit`: once the server is closed
  // nothing keeps the process, and the last log lines are not cut off in a pipe.
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    relay.close().then(
      () => undefined,
      (err: unknown) => {
        process.stderr.write(`The relay did not stop cleanly: ${String(err)}\n`)
        process.exitCode = 1
      },
    )
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // A token on demand, from the running relay, which stays the only writer of its file
  // (review of #219). SIGUSR2, since Node keeps SIGUSR1 for its debugger; Windows has none.
  if (process.platform !== 'win32') {
    process.on('SIGUSR2', () => {
      relay.issueToken().catch((err: unknown) => {
        process.stderr.write(`No token was issued: ${String(err)}\n`)
      })
    })
  }
}

// Run only as the program, not when a test imports this file.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
