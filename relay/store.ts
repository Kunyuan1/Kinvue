import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DELIVERY_RETENTION_MS,
  ENVELOPE_RETENTION_MS,
  isKey,
  type Deliveries,
  type Envelope,
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
  /** When they fetched, inside #31's window. */
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
  | { kind: 'posted'; added: number }
  /** An envelope for a key that is not an enrolled viewer: nothing was written. */
  | { kind: 'unknown-viewer'; viewer: string }
  /** The same stream number already holds different bytes: nothing was written. */
  | { kind: 'conflict'; viewer: string; stream: number }

export interface RelayStore {
  /** What `key` is here, or null when it is nothing. */
  roleOf(key: string): Promise<Role | null>
  /** Envelopes into their viewers' mailboxes, all of them or none. */
  post(envelopes: Envelope[], at: number): Promise<PostResult>
  /** What waits for `viewer`, recording that they fetched. */
  fetch(viewer: string, at: number): Promise<Waiting[]>
  /** `viewer` holds everything up to `through`; those go. */
  ack(viewer: string, through: number, at: number): Promise<void>
  /** When each enrolled viewer fetched, inside the window. */
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
    if (!isNumber(viewer.enrolledAt) || !isNumber(viewer.ackedThrough)) {
      return `viewers.${key}: enrolledAt or ackedThrough not a number`
    }
    if (!Array.isArray(viewer.fetchedAt) || !viewer.fetchedAt.every(isNumber)) {
      return `viewers.${key}.fetchedAt: not a list of times`
    }
    if (!Array.isArray(viewer.waiting)) return `viewers.${key}.waiting: not a list`
    for (const waiting of viewer.waiting as unknown[]) {
      const w = waiting as Partial<Waiting> | null
      if (w === null || !isNumber(w.stream) || !isNumber(w.postedAt)) {
        return `viewers.${key}.waiting: an envelope without its stream or time`
      }
      if (typeof w.sealed !== 'string') return `viewers.${key}.waiting: an envelope without bytes`
    }
  }
  if (typeof state.ended !== 'object' || state.ended === null) return 'ended: not an object'
  for (const [key, at] of Object.entries(state.ended as Record<string, unknown>)) {
    if (!isKey(key) || !isNumber(at)) return `ended: ${key} is not a key and a time`
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

  const write = async (next: RelayState): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await rename(tmp, path)
    state = Promise.resolve(next)
  }

  /** `change` edits a copy and says whether to write it; the copy becomes the state. */
  const change = <T>(at: number, edit: (draft: RelayState) => { result: T; write: boolean }) =>
    serial(async () => {
      const draft = structuredClone(await current())
      const expired = pruned(draft, at)
      const { result, write: changed } = edit(draft)
      if (changed || expired) await write(draft)
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
        let added = 0
        for (const envelope of envelopes) {
          const viewer = Object.hasOwn(draft.viewers, envelope.viewer)
            ? draft.viewers[envelope.viewer]
            : undefined
          if (viewer === undefined) {
            return { result: { kind: 'unknown-viewer', viewer: envelope.viewer }, write: false }
          }
          // Taken and acknowledged already: a resend is the outbox doing its job (#41).
          if (envelope.stream <= viewer.ackedThrough) continue
          const there = viewer.waiting.find((w) => w.stream === envelope.stream)
          if (there !== undefined) {
            if (there.sealed === envelope.sealed) continue
            const result = { kind: 'conflict', viewer: envelope.viewer, stream: envelope.stream }
            return { result: result as PostResult, write: false }
          }
          viewer.waiting.push({ stream: envelope.stream, sealed: envelope.sealed, postedAt: at })
          added += 1
        }
        for (const viewer of Object.values(draft.viewers)) {
          viewer.waiting.sort((a, b) => a.stream - b.stream)
        }
        return { result: { kind: 'posted', added }, write: added > 0 }
      }),

    fetch: (key, at) =>
      change(at, (draft) => {
        const viewer = draft.viewers[key]
        if (viewer === undefined) return { result: [], write: false }
        viewer.fetchedAt.push(at)
        return { result: viewer.waiting.map((w) => ({ ...w })), write: true }
      }),

    ack: (key, through, at) =>
      change(at, (draft) => {
        const viewer = draft.viewers[key]
        if (viewer === undefined || through <= viewer.ackedThrough) {
          return { result: undefined, write: false }
        }
        viewer.ackedThrough = through
        viewer.waiting = viewer.waiting.filter((w) => w.stream > through)
        return { result: undefined, write: true }
      }),

    deliveries: (at) =>
      change<Deliveries>(at, (draft) => ({
        result: {
          viewers: Object.entries(draft.viewers).map(([viewer, entry]) => ({
            viewer,
            fetchedAt: [...entry.fetchedAt],
          })),
        },
        write: false,
      })),

    revoke: (key, at) =>
      change(at, (draft) => {
        if (Object.hasOwn(draft.ended, key)) return { result: true, write: false }
        if (!Object.hasOwn(draft.viewers, key)) return { result: false, write: false }
        delete draft.viewers[key]
        draft.ended[key] = at
        return { result: true, write: true }
      }),

    expire: (at) => change(at, () => ({ result: undefined, write: false })),

    enrolDevice: (key, at) =>
      change(at, (draft) => {
        draft.device = key
        return { result: undefined, write: true }
      }),

    enrolViewer: (key, receiveKey, at) =>
      change(at, (draft) => {
        delete draft.ended[key]
        draft.viewers[key] = {
          receiveKey,
          enrolledAt: at,
          ackedThrough: 0,
          waiting: [],
          fetchedAt: [],
        }
        return { result: undefined, write: true }
      }),
  }
}
