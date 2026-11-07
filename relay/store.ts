import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DELIVERY_RETENTION_MS,
  ENVELOPE_RETENTION_MS,
  isKey,
  isSealed,
  isStream,
  type Deliveries,
  type Envelope,
  type Posted,
  type Waiting,
} from '@kinvue/core/sync/protocol'

/**
 * What the household's relay holds, in one JSON file (KV-39).
 *
 * Only what KV-33 says it may: the keys of the check-in device and of each viewer it
 * enrolled, sealed envelopes waiting for their viewer, and when each viewer fetched. No
 * names, no readings, nothing it could open. And the keys of viewers whose sharing ended,
 * with when, so a viewer coming back after any gap is told it ended rather than that it is
 * unknown — told is what makes their app delete its copy (KV-31).
 *
 * **Retention is enforced here, and is the operator's policy, not a control** (KV-33, T3,
 * T4): an envelope older than 14 days and a fetch older than 30 are dropped on every
 * write, and an operator who wanted more could change this file. What holds against that
 * operator is what the file holds.
 *
 * **Retention runs on this machine's clock.** A clock jumping forward 14 days drops every
 * waiting envelope, and nothing records that it happened (review of #216). Nothing is lost
 * for good — the check-in device is the outbox, and seals again from each viewer's
 * acknowledged stream — but delivery waits for it to notice. Guarding against a clock
 * moving backward would be riskier than the jump, so there is no guard.
 *
 * **Ending a viewer's sharing erases when they fetched**, with their mailbox, at once
 * rather than after the 30 days (review of #216). Deliberate: the access history is for
 * deciding about the people who have access, and once a viewer has none, keeping when they
 * looked is metadata about them the relay no longer needs (T4). The person's own device
 * keeps whatever it already read.
 *
 * One process owns the file. Every change is made to a copy, written (temporary file,
 * then rename, as `core/session/store.ts` does), and only then becomes the state, so a
 * failed write leaves memory and disk agreeing. Changes run one at a time.
 */

export const RELAY_FILE_VERSION = 1

interface ViewerEntry {
  /** Their X25519 key, which the check-in device seals to. Kept, never used here. */
  receiveKey: string
  enrolledAt: number
  /** Everything up to this stream number has been acknowledged, and is not taken again. */
  ackedThrough: number
  waiting: Waiting[]
  /** When a fetch delivered them envelopes, inside #31's window. Empty fetches are not kept. */
  fetchedAt: number[]
}

interface RelayState {
  version: typeof RELAY_FILE_VERSION
  /** The check-in device's signing key, once enrolled (#39's second PR). */
  device: string | null
  viewers: Record<string, ViewerEntry>
  /** Viewers whose sharing ended, and when. */
  ended: Record<string, number>
}

export type Role = 'device' | 'viewer' | 'ended'

export type PostResult =
  | ({ kind: 'posted' } & Posted)
  /** An envelope for a key that is not an enrolled viewer: nothing was written. */
  | { kind: 'unknown-viewer'; viewer: string }

export type AckResult =
  | { kind: 'acked' }
  /** A stream inside the ack was never held for them: nothing was written (review of #216). */
  | { kind: 'gap'; missing: number }

export interface RelayStore {
  /** What `key` is here, or null when it is nothing. */
  roleOf(key: string): Promise<Role | null>
  /** Envelopes into their viewers' mailboxes, all of them or none. */
  post(envelopes: Envelope[], at: number): Promise<PostResult>
  /** What waits for `viewer`, recording that they fetched when anything did. */
  fetch(viewer: string, at: number): Promise<Waiting[]>
  /** `viewer` holds every stream up to `through`; those go. Refused over a gap. */
  ack(viewer: string, through: number, at: number): Promise<AckResult>
  /** When each enrolled viewer fetched, inside the window, and where their stream stands. */
  deliveries(at: number): Promise<Deliveries>
  /** Sharing with `viewer` ends: their mailbox and enrolment go together. False if unknown. */
  revoke(viewer: string, at: number): Promise<boolean>
  /** Drops what retention says has gone, and writes if anything did. */
  expire(at: number): Promise<void>
  /** The check-in device's key. Enrolment by token is the second PR's; this is its write. */
  enrolDevice(key: string, at: number): Promise<void>
  /** A viewer, as a confirmed pairing will enrol them (the second PR). */
  enrolViewer(key: string, receiveKey: string, at: number): Promise<void>
}

/** The relay file was written by a newer relay. Refused whole, as the history is (KV-13). */
export class NewerRelayFileError extends Error {
  constructor(readonly version: unknown) {
    super(`The relay file is version ${String(version)}, newer than this relay reads.`)
  }
}

/** The relay file is not one this relay wrote. Refused, never repaired. */
export class UnreadableRelayFileError extends Error {}

const empty = (): RelayState => ({
  version: RELAY_FILE_VERSION,
  device: null,
  viewers: {},
  ended: {},
})

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Why `value` is not a relay file, or null when it is. Checked as read; never repaired. */
function problemWith(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'not an object'
  const state = value as Record<string, unknown>
  if (state.device !== null && !isKey(state.device)) return 'device: not a key'
  if (typeof state.viewers !== 'object' || state.viewers === null) return 'viewers: not an object'
  for (const [key, entry] of Object.entries(state.viewers as Record<string, unknown>)) {
    if (!isKey(key)) return `viewers: ${key} is not a key`
    const viewer = entry as Partial<ViewerEntry> | null
    if (viewer === null || typeof viewer !== 'object') return `viewers.${key}: not an object`
    if (!isKey(viewer.receiveKey)) return `viewers.${key}.receiveKey: not a key`
    if (!isNumber(viewer.enrolledAt)) return `viewers.${key}.enrolledAt: not a time`
    const acked = viewer.ackedThrough
    if (!(acked === 0 || isStream(acked))) {
      return `viewers.${key}.ackedThrough: not 0 or a stream number`
    }
    if (!Array.isArray(viewer.fetchedAt) || !viewer.fetchedAt.every(isNumber)) {
      return `viewers.${key}.fetchedAt: not a list of times`
    }
    if (!Array.isArray(viewer.waiting)) return `viewers.${key}.waiting: not a list`
    // Above the ack, each once, in order: what `post` and `ack` keep, and `ack`'s walk
    // over what waits relies on.
    let previous = acked
    for (const waiting of viewer.waiting as unknown[]) {
      const w = waiting as Partial<Waiting> | null
      if (w === null || !isStream(w.stream) || !isNumber(w.postedAt)) {
        return `viewers.${key}.waiting: an envelope without its stream or time`
      }
      if (!isSealed(w.sealed)) return `viewers.${key}.waiting: an envelope without its bytes`
      if (w.stream <= previous) {
        return `viewers.${key}.waiting: stream ${w.stream} not above ${previous}`
      }
      previous = w.stream
    }
  }
  if (typeof state.ended !== 'object' || state.ended === null) return 'ended: not an object'
  for (const [key, at] of Object.entries(state.ended as Record<string, unknown>)) {
    if (!isKey(key) || !isNumber(at)) return `ended: ${key} is not a key and a time`
    // One role per key (review of #216): `roleOf` reads viewers first, so a key in both
    // would keep its access and never be told its sharing ended.
    if (Object.hasOwn(state.viewers, key)) return `${key}: both a viewer and ended`
  }
  if (typeof state.device === 'string') {
    if (Object.hasOwn(state.viewers, state.device)) return 'device: also a viewer'
    if (Object.hasOwn(state.ended, state.device)) return 'device: also ended'
  }
  return null
}

async function load(path: string): Promise<RelayState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UnreadableRelayFileError('The relay file is not JSON.')
  }
  const version = (parsed as { version?: unknown } | null)?.version
  if (isNumber(version) && version > RELAY_FILE_VERSION) throw new NewerRelayFileError(version)
  if (version !== RELAY_FILE_VERSION) {
    throw new UnreadableRelayFileError(`The relay file has no version this relay reads.`)
  }
  const problem = problemWith(parsed)
  if (problem !== null) throw new UnreadableRelayFileError(`The relay file: ${problem}.`)
  return parsed as RelayState
}

/** Drops what retention says has gone. True when anything did. */
function pruned(state: RelayState, at: number): boolean {
  let changed = false
  for (const viewer of Object.values(state.viewers)) {
    const waiting = viewer.waiting.filter((w) => at - w.postedAt < ENVELOPE_RETENTION_MS)
    const fetchedAt = viewer.fetchedAt.filter((t) => at - t < DELIVERY_RETENTION_MS)
    if (waiting.length !== viewer.waiting.length || fetchedAt.length !== viewer.fetchedAt.length) {
      changed = true
      viewer.waiting = waiting
      viewer.fetchedAt = fetchedAt
    }
  }
  return changed
}

/** What a change does with its edited copy. */
type Then = 'write' | 'keep' | 'refuse'

export function createRelayStore(path: string): RelayStore {
  let state: Promise<RelayState> | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const current = (): Promise<RelayState> => (state ??= load(path))

  /** Runs `fn` after every change before it, whether or not those succeeded. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  /**
   * One temporary name, as `core/session/store.ts` uses, so a later write takes the place
   * of whatever an earlier one left; and removed when the write fails, since it holds the
   * whole state — sealed envelopes included — where retention would never reach it
   * (review of #216). Writes are serial, so one name is never shared by two at once.
   */
  const write = async (next: RelayState): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
      await rename(tmp, path)
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
    state = Promise.resolve(next)
  }

  /**
   * `change` edits a copy and says what becomes of it: `write` it, `keep` nothing to
   * write, or `refuse` — its edits thrown away, whatever it had done before refusing.
   *
   * Expiry is applied first, to a copy of its own, and is written whatever the edit says,
   * since retention is promised on every write. So a refused edit writes the expired copy,
   * never its own: a batch refused halfway leaves none of its first half behind, even
   * when something expired in the same call (review of #216).
   */
  const change = <T>(at: number, edit: (draft: RelayState) => { result: T; then: Then }) =>
    serial(async () => {
      const kept = structuredClone(await current())
      const expired = pruned(kept, at)
      const draft = structuredClone(kept)
      const { result, then } = edit(draft)
      if (then === 'write') await write(draft)
      else if (expired) await write(kept)
      return result
    })

  return {
    async roleOf(key) {
      const now = await current()
      if (now.device === key) return 'device'
      if (Object.hasOwn(now.viewers, key)) return 'viewer'
      if (Object.hasOwn(now.ended, key)) return 'ended'
      return null
    },

    post: (envelopes, at) =>
      change<PostResult>(at, (draft) => {
        const posted: Posted = { added: 0, replaced: 0, held: 0, acknowledged: 0 }
        for (const envelope of envelopes) {
          const viewer = Object.hasOwn(draft.viewers, envelope.viewer)
            ? draft.viewers[envelope.viewer]
            : undefined
          if (viewer === undefined) {
            return { result: { kind: 'unknown-viewer', viewer: envelope.viewer }, then: 'refuse' }
          }
          // The viewer holds it: not taken, and said so apart from what was added.
          if (envelope.stream <= viewer.ackedThrough) {
            posted.acknowledged += 1
            continue
          }
          const there = viewer.waiting.find((w) => w.stream === envelope.stream)
          if (there?.sealed === envelope.sealed) {
            posted.held += 1
          } else if (there !== undefined) {
            // A reseal: the same sender, at a stream not yet acknowledged. Its wait starts
            // again, as a new envelope's would (the protocol's resume contract).
            there.sealed = envelope.sealed
            there.postedAt = at
            posted.replaced += 1
          } else {
            viewer.waiting.push({ stream: envelope.stream, sealed: envelope.sealed, postedAt: at })
            posted.added += 1
          }
        }
        for (const viewer of Object.values(draft.viewers)) {
          viewer.waiting.sort((a, b) => a.stream - b.stream)
        }
        const changed = posted.added + posted.replaced > 0
        return { result: { kind: 'posted', ...posted }, then: changed ? 'write' : 'keep' }
      }),

    fetch: (key, at) =>
      change(at, (draft) => {
        const viewer = draft.viewers[key]
        // A fetch that delivered nothing is no look: KV-31's history is taken from what the
        // relay delivered, and a viewer's app polling an empty mailbox would otherwise bury
        // the looks under thousands of polls, and rewrite the file for each (review of #216).
        if (viewer === undefined || viewer.waiting.length === 0) return { result: [], then: 'keep' }
        viewer.fetchedAt.push(at)
        return { result: viewer.waiting.map((w) => ({ ...w })), then: 'write' }
      }),

    ack: (key, through, at) =>
      change<AckResult>(at, (draft) => {
        const viewer = draft.viewers[key]
        if (viewer === undefined || through <= viewer.ackedThrough) {
          return { result: { kind: 'acked' }, then: 'keep' }
        }
        // Contiguous, or not at all: a stream it skips could never be delivered after.
        // Walked over what waits, in order, never counted up to `through`, which the
        // viewer chooses.
        let next = viewer.ackedThrough + 1
        for (const { stream } of viewer.waiting) {
          if (stream === next) next += 1
          if (next > through) break
        }
        if (next <= through) return { result: { kind: 'gap', missing: next }, then: 'refuse' }
        viewer.ackedThrough = through
        viewer.waiting = viewer.waiting.filter((w) => w.stream > through)
        return { result: { kind: 'acked' }, then: 'write' }
      }),

    deliveries: (at) =>
      change<Deliveries>(at, (draft) => ({
        result: {
          viewers: Object.entries(draft.viewers).map(([viewer, entry]) => ({
            viewer,
            fetchedAt: [...entry.fetchedAt],
            ackedThrough: entry.ackedThrough,
            highestWaiting: entry.waiting.at(-1)?.stream ?? null,
          })),
        },
        then: 'keep',
      })),

    revoke: (key, at) =>
      change(at, (draft) => {
        if (Object.hasOwn(draft.ended, key)) return { result: true, then: 'keep' }
        if (!Object.hasOwn(draft.viewers, key)) return { result: false, then: 'keep' }
        delete draft.viewers[key]
        draft.ended[key] = at
        return { result: true, then: 'write' }
      }),

    expire: (at) => change(at, () => ({ result: undefined, then: 'keep' })),

    enrolDevice: (key, at) =>
      change(at, (draft) => {
        if (Object.hasOwn(draft.viewers, key) || Object.hasOwn(draft.ended, key)) {
          throw new Error('That key is already a viewer here, or was one.')
        }
        draft.device = key
        return { result: undefined, then: 'write' }
      }),

    enrolViewer: (key, receiveKey, at) =>
      change(at, (draft) => {
        if (draft.device === key) throw new Error('That key is already the check-in device.')
        // A viewer whose sharing ended can be approved again at the device: a new pairing.
        delete draft.ended[key]
        draft.viewers[key] = {
          receiveKey,
          enrolledAt: at,
          ackedThrough: 0,
          waiting: [],
          fetchedAt: [],
        }
        return { result: undefined, then: 'write' }
      }),
  }
}
