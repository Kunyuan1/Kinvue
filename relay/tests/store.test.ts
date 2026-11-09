import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELIVERY_RETENTION_MS, ENVELOPE_RETENTION_MS } from '@kinvue/core/sync/protocol'
import {
  createRelayStore,
  NewerRelayFileError,
  RELAY_FILE_VERSION,
  UnreadableRelayFileError,
} from '../store'
import { identity, receiveKey, sealed } from './helpers'

let dir: string
let path: string
const device = identity().key
const ann = identity().key
const T0 = Date.UTC(2026, 10, 5)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kinvue-relay-store-'))
  path = join(dir, 'relay.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A relay file, as text: everything empty unless `fields` says otherwise. */
const fileOf = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    version: RELAY_FILE_VERSION,
    device: null,
    deviceReceiveKey: null,
    viewers: {},
    ended: {},
    tokens: {},
    pairings: {},
    // A device's two keys come together, so a file naming one names both.
    ...(typeof fields.device === 'string' ? { deviceReceiveKey: receiveKey() } : {}),
    ...fields,
  })

/** A relay file holding Ann as a viewer, her entry changed by `entry`. */
const withAnn = (entry: Record<string, unknown>, fields: Record<string, unknown> = {}): string =>
  fileOf({
    viewers: {
      [ann]: {
        receiveKey: receiveKey(),
        enrolledAt: 0,
        ackedThrough: 0,
        waiting: [],
        fetchedAt: [],
        ...entry,
      },
    },
    ...fields,
  })

const waiting = (stream: number) => ({ stream, sealed: sealed(`stream ${stream}`), postedAt: 0 })

async function enrolled() {
  const store = createRelayStore(path)
  await store.enrolDevice(device, receiveKey(), T0)
  await store.enrolViewer(ann, receiveKey(), T0)
  return store
}

describe('retention, as KV-33 sets it', () => {
  it('drops an envelope 14 days after it was posted, not before', async () => {
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    await store.expire(T0 + ENVELOPE_RETENTION_MS - 1)
    expect(await store.fetch(ann, T0 + ENVELOPE_RETENTION_MS - 1)).toHaveLength(1)
    await store.expire(T0 + ENVELOPE_RETENTION_MS)
    expect(await store.fetch(ann, T0 + ENVELOPE_RETENTION_MS)).toEqual([])
  })

  it('forgets a fetch 30 days after it, not before', async () => {
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    await store.fetch(ann, T0)
    const before = await store.deliveries(T0 + DELIVERY_RETENTION_MS - 1)
    expect(before.viewers[0]?.fetchedAt).toEqual([T0])
    const after = await store.deliveries(T0 + DELIVERY_RETENTION_MS)
    expect(after.viewers[0]?.fetchedAt).toEqual([])
  })

  it('reads without writing, and leaves out what has expired (review of #218)', async () => {
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    await store.fetch(ann, T0)
    const { pairing } = await store.openPairing(T0)
    const before = await readFile(path, 'utf8')
    // Everything here has expired by now: shown as gone, and still in the file.
    const later = T0 + DELIVERY_RETENTION_MS
    const standing = (await store.deliveries(later)).viewers[0]
    expect(standing).toMatchObject({ fetchedAt: [], highestWaiting: null })
    expect(await store.pairing(pairing, later)).toBeNull()
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('writes the expiry, so a restart does not bring an expired envelope back', async () => {
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    await store.expire(T0 + ENVELOPE_RETENTION_MS)
    expect(await readFile(path, 'utf8')).not.toContain(sealed('one'))
  })
})

describe('a refused batch, while something expires (review of #216)', () => {
  it('writes the expiry and none of the batch, and a restart agrees', async () => {
    // Two guards, each right alone: retention writes on every change, and a refused
    // batch writes nothing. Together, the batch's first half was written with the
    // expiry. Only a test that runs both at once can see it.
    const store = await enrolled()
    const bill = identity().key
    await store.enrolViewer(bill, receiveKey(), T0)
    await store.post([{ viewer: bill, stream: 1, sealed: sealed('old') }], T0)
    const later = T0 + ENVELOPE_RETENTION_MS + 1
    const refused = await store.post(
      [
        { viewer: ann, stream: 1, sealed: sealed('first') },
        { viewer: identity().key, stream: 1, sealed: sealed('nobody') },
      ],
      later,
    )
    expect(refused.kind).toBe('unknown-viewer')
    expect(await store.fetch(ann, later)).toEqual([])
    const reloaded = createRelayStore(path)
    expect(await reloaded.fetch(ann, later)).toEqual([])
    expect(await reloaded.fetch(bill, later)).toEqual([])
  })
})

describe('the file', () => {
  it('holds what was written for the next relay process', async () => {
    const first = await enrolled()
    await first.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    const second = createRelayStore(path)
    expect(await second.roleOf(device)).toBe('device')
    expect(await second.roleOf(ann)).toBe('viewer')
    expect(await second.fetch(ann, T0)).toHaveLength(1)
  })

  it('holds no name and nothing it could read: keys, times and sealed bytes', async () => {
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(file).sort()).toEqual([
      'device',
      'deviceReceiveKey',
      'ended',
      'pairings',
      'tokens',
      'version',
      'viewers',
    ])
  })

  it('remembers an ended viewer across a restart', async () => {
    const store = await enrolled()
    await store.revoke(ann, T0)
    expect(await createRelayStore(path).roleOf(ann)).toBe('ended')
  })

  it('refuses a file a newer relay wrote, rather than reading past it', async () => {
    await writeFile(path, JSON.stringify({ version: RELAY_FILE_VERSION + 1 }), 'utf8')
    await expect(createRelayStore(path).roleOf(ann)).rejects.toBeInstanceOf(NewerRelayFileError)
  })

  it.each([
    ['not JSON', 'nope'],
    ['no version', JSON.stringify({ device: null, viewers: {}, ended: {} })],
    ['a device that is not a key', fileOf({ device: 'x', deviceReceiveKey: receiveKey() })],
    ['an envelope without its bytes', withAnn({ waiting: [{ stream: 1, postedAt: 0 }] })],
    // What the routes would never admit (review of #216): the check is all that stands
    // between a hand-edited or downgraded file and them.
    ['a viewer who is also ended', withAnn({}, { ended: { [ann]: 0 } })],
    ['the device also a viewer', withAnn({}, { device: ann })],
    ['the device also ended', fileOf({ device: ann, ended: { [ann]: 0 } })],
    ['an ack below zero', withAnn({ ackedThrough: -1 })],
    ['a fractional ack', withAnn({ ackedThrough: 1.5 })],
    ['a waiting stream at or below the ack', withAnn({ ackedThrough: 2, waiting: [waiting(2)] })],
    ['a waiting stream twice', withAnn({ waiting: [waiting(1), waiting(1)] })],
    ['waiting streams out of order', withAnn({ waiting: [waiting(2), waiting(1)] })],
    ['sealed bytes not in base64url', withAnn({ waiting: [{ ...waiting(1), sealed: 'a+b' }] })],
    ['an ended key that is not canonical', fileOf({ ended: { [`${ann.slice(0, -1)}B`]: 0 } })],
    // What letting someone in leaves for a while (KV-39).
    ['a device with one of its two keys', fileOf({ device: ann, deviceReceiveKey: null })],
    ['a token kept as itself, not its hash', fileOf({ tokens: { [sealed('token')]: 0 } })],
    ['a pairing id not in base32', fileOf({ pairings: { 'abc': { expiresAt: 0, viewer: null } } })],
    ['a pairing that is not an object', fileOf({ pairings: { ABCDEFGHJK: 7 } })],
    [
      'a pairing joined by a viewer already in',
      withAnn(
        {},
        {
          pairings: {
            ABCDEFGHJK: { expiresAt: 0, viewer: { key: ann, receiveKey: receiveKey() } },
          },
        },
      ),
    ],
    [
      'a pairing joined by half a viewer',
      fileOf({ pairings: { ABCDEFGHJK: { expiresAt: 0, viewer: { key: ann } } } }),
    ],
  ])('refuses a file with %s, and repairs nothing', async (what, text) => {
    await writeFile(path, text, 'utf8')
    const refusal = createRelayStore(path).roleOf(ann)
    await expect(refusal).rejects.toBeInstanceOf(UnreadableRelayFileError)
    // Refused for what is wrong with it, not for its version (review of #218): a case
    // written at the wrong version would pass on that alone, and prove nothing.
    if (what !== 'not JSON' && what !== 'no version') {
      await expect(refusal).rejects.toThrow(/^The relay file: /)
    }
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('refuses a file an older relay wrote, and says so (review of #218)', async () => {
    const older = fileOf({ version: RELAY_FILE_VERSION - 1 })
    await writeFile(path, older, 'utf8')
    await expect(createRelayStore(path).roleOf(ann)).rejects.toThrow(/written by an older relay/)
  })

  it('reads as version 2: the device’s receiving key, tokens and pairings', () => {
    expect(RELAY_FILE_VERSION).toBe(2)
  })

  it('leaves no copy of the state behind when a write fails (review of #216)', async () => {
    // A temporary file left by a failed write holds every sealed envelope, and retention
    // never reaches it. Here the rename fails: the file's place is taken by a folder.
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    await rm(path)
    await mkdir(path)
    await expect(store.revoke(ann, T0)).rejects.toThrow()
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('reads a file it wrote with every invariant holding', async () => {
    const store = await enrolled()
    await store.post(
      [1, 2, 3].map((stream) => ({ viewer: ann, stream, sealed: sealed(`s${stream}`) })),
      T0,
    )
    await store.fetch(ann, T0)
    await store.ack(ann, 1, T0)
    await store.enrolViewer(identity().key, receiveKey(), T0)
    await store.revoke(ann, T0)
    await expect(createRelayStore(path).roleOf(ann)).resolves.toBe('ended')
  })

  it('refuses to enrol a key under both roles (review of #216)', async () => {
    const store = await enrolled()
    await expect(store.enrolDevice(ann, receiveKey(), T0)).rejects.toThrow(/already/)
    await expect(store.enrolViewer(device, receiveKey(), T0)).rejects.toThrow(/already/)
    await store.revoke(ann, T0)
    await expect(store.enrolDevice(ann, receiveKey(), T0)).rejects.toThrow(/already/)
    expect(await store.roleOf(ann)).toBe('ended')
  })

  it('lets nobody join a pairing while no device is enrolled to give them keys', async () => {
    // Unreachable over HTTP, where only an enrolled device opens one; held here for a
    // file that says otherwise.
    const store = createRelayStore(path)
    const { pairing } = await store.openPairing(T0)
    const keys = { key: ann, receiveKey: receiveKey() }
    expect(await store.join(pairing, keys, T0)).toEqual({ kind: 'unknown' })
  })

  it('confirms no viewer over one already enrolled (review of #218)', async () => {
    // `join` checks too; this holds without leaning on one pairing at a time.
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    const { pairing } = await store.openPairing(T0)
    const bill = { key: identity().key, receiveKey: receiveKey() }
    expect((await store.join(pairing, bill, T0)).kind).toBe('joined')
    await store.enrolViewer(bill.key, receiveKey(), T0)
    await store.post([{ viewer: bill.key, stream: 1, sealed: sealed('for bill') }], T0)
    expect(await store.confirm(pairing, T0)).toBe('key-in-use')
    expect(await store.fetch(bill.key, T0)).toHaveLength(1)
  })

  it('keeps the state it had when a write fails', async () => {
    const store = await enrolled()
    // Where the temporary file would go is now a file, not a folder: the write fails.
    await rm(dir, { recursive: true, force: true })
    await writeFile(dir, 'in the way', 'utf8')
    await expect(store.revoke(ann, T0)).rejects.toThrow()
    expect(await store.roleOf(ann)).toBe('viewer')
    await rm(dir, { force: true })
  })
})
