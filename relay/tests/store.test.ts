import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_RETENTION_MS,
  MAX_DELIVERIES_KEPT_PER_VIEWER,
  ENROL_TOKEN_TTL_MS,
  ENVELOPE_RETENTION_MS,
} from '@kinvue/core/sync/protocol'
import {
  createRelayStore,
  NewerRelayFileError,
  RELAY_FILE_VERSION,
  UnreadableRelayFileError,
} from '../store'
import { identity, receiveKey, sealed } from './helpers'

/**
 * What reached the disk, in order (KV-223): each flush of a file and each rename, by the
 * file's name. Everything else is the real file system.
 */
const disk = vi.hoisted(() => ({ events: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args)
      const sync = file.sync.bind(file)
      file.sync = async (): Promise<void> => {
        await sync()
        disk.events.push(`sync ${basename(String(args[0]))}`)
      }
      return file
    },
    rename: async (from: string, to: string): Promise<void> => {
      await actual.rename(from, to)
      disk.events.push(`rename ${basename(from)}`)
    },
  }
})

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

const SHARED = receiveKey()
const DEVICE_KEY = identity().key
const DEVICE_RECEIVE = receiveKey()

/** A viewer's entry in a relay file, receiving at `receive`. */
const viewerEntry = (receive: string) => ({
  receiveKey: receive,
  enrolledAt: 0,
  ackedThrough: 0,
  waiting: [],
  fetchedAt: [],
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

  describe('what a fetch records (KV-224)', () => {
    const times = async (store: Awaited<ReturnType<typeof enrolled>>, at: number) =>
      (await store.deliveries(at)).viewers.find((v) => v.viewer === ann)?.fetchedAt

    it('records the same envelopes once, however often they are fetched, and stops writing', async () => {
      // A viewer's app that fetches and never acknowledges: what waits stays, so every
      // poll is handed the same envelopes. One delivery, and a file that does not grow.
      const store = await enrolled()
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
      expect(await store.fetch(ann, T0 + 1)).toHaveLength(1)
      const after = await readFile(path, 'utf8')
      for (let poll = 2; poll <= 50; poll++) {
        expect(await store.fetch(ann, T0 + poll)).toHaveLength(1)
      }
      expect(await times(store, T0 + 60)).toEqual([T0 + 1])
      expect(await readFile(path, 'utf8')).toBe(after)
    })

    it('records again when something new waits, acknowledged or not', async () => {
      const store = await enrolled()
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
      await store.fetch(ann, T0 + 1)
      await store.post([{ viewer: ann, stream: 2, sealed: sealed('two') }], T0 + 2)
      // Both are handed over; the second is the news.
      expect(await store.fetch(ann, T0 + 3)).toHaveLength(2)
      await store.ack(ann, 2, T0 + 4)
      await store.post([{ viewer: ann, stream: 3, sealed: sealed('three') }], T0 + 5)
      await store.fetch(ann, T0 + 6)
      expect(await times(store, T0 + 7)).toEqual([T0 + 1, T0 + 3, T0 + 6])
    })

    it('still knows what was delivered after a restart', async () => {
      const store = await enrolled()
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
      await store.fetch(ann, T0 + 1)
      const restarted = createRelayStore(path)
      await restarted.fetch(ann, T0 + 2)
      expect(await times(restarted, T0 + 3)).toEqual([T0 + 1])
    })

    it('records a reseal: different bytes at a stream already handed over (review of #250)', async () => {
      // The relay cannot open the box, so it cannot know a reseal says what the last
      // one did. Handed over, it is bytes this viewer had not held.
      const store = await enrolled()
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
      await store.fetch(ann, T0 + 1)
      const posted = await store.post([{ viewer: ann, stream: 1, sealed: sealed('other') }], T0 + 2)
      expect(posted).toMatchObject({ kind: 'posted', replaced: 1 })
      expect((await store.fetch(ann, T0 + 3)).map((w) => w.sealed)).toEqual([sealed('other')])
      // And once: the reseal fetched again is the same bytes again.
      await store.fetch(ann, T0 + 4)
      expect(await times(store, T0 + 5)).toEqual([T0 + 1, T0 + 3])
      // A resend, byte for byte, is nothing new.
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('other') }], T0 + 6)
      await store.fetch(ann, T0 + 7)
      expect(await times(store, T0 + 8)).toEqual([T0 + 1, T0 + 3])
    })

    it('records an envelope posted below one already handed over (review of #250)', async () => {
      // A device's first post failed and its second landed; the retry fills in beneath.
      const store = await enrolled()
      await store.post(
        [
          { viewer: ann, stream: 1, sealed: sealed('one') },
          { viewer: ann, stream: 3, sealed: sealed('three') },
        ],
        T0,
      )
      await store.fetch(ann, T0 + 1)
      await store.post([{ viewer: ann, stream: 2, sealed: sealed('two') }], T0 + 2)
      expect((await store.fetch(ann, T0 + 3)).map((w) => w.stream)).toEqual([1, 2, 3])
      expect(await times(store, T0 + 4)).toEqual([T0 + 1, T0 + 3])
    })

    it('records an envelope sealed again after it and its delivery expired (review of #250)', async () => {
      // Handed over, never acknowledged, gone at 14 days; its delivery gone at 30. The
      // device seals it again from the ack, as the resume contract says. Without a
      // record here the list would be empty for a viewer handed data a moment before.
      const store = await enrolled()
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
      await store.fetch(ann, T0 + 1)
      const later = T0 + DELIVERY_RETENTION_MS + 1
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], later)
      expect(await store.fetch(ann, later + 1)).toHaveLength(1)
      expect(await times(store, later + 2)).toEqual([later + 1])
    })

    it('hands over the envelope and never the relay\u2019s note on it', async () => {
      const store = await enrolled()
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
      const first = await store.fetch(ann, T0 + 1)
      const again = await store.fetch(ann, T0 + 2)
      for (const handed of [first, again]) {
        expect(handed).toEqual([{ stream: 1, sealed: sealed('one'), postedAt: T0 }])
      }
    })

    it(`keeps the newest ${MAX_DELIVERIES_KEPT_PER_VIEWER} deliveries, and the list stops growing`, async () => {
      // A file already at the ceiling: one delivery for each stream so far, all acknowledged.
      const full = MAX_DELIVERIES_KEPT_PER_VIEWER
      await writeFile(
        path,
        fileOf({
          device,
          viewers: {
            [ann]: {
              ...viewerEntry(receiveKey()),
              ackedThrough: full,
              fetchedAt: Array.from({ length: full }, (_, i) => T0 + i + 1),
            },
          },
        }),
      )
      const store = createRelayStore(path)
      const past = full + 5
      const lengths: number[] = []
      for (let stream = full + 1; stream <= past; stream++) {
        await store.post([{ viewer: ann, stream, sealed: sealed('x') }], T0 + stream)
        await store.fetch(ann, T0 + stream)
        // Read as the fetch left it, before any later write could trim it instead.
        const inFile = JSON.parse(await readFile(path, 'utf8')) as {
          viewers: Record<string, { fetchedAt: number[] }>
        }
        lengths.push(inFile.viewers[ann]!.fetchedAt.length)
        await store.ack(ann, stream, T0 + stream)
      }
      // In the file, not only in what is served: every delivery past the ceiling leaves
      // the list the length it was.
      expect(lengths).toEqual(Array.from({ length: 5 }, () => full))
      const kept = await times(store, T0 + past)
      // The oldest went: the latest is never the one lost.
      expect(kept?.[0]).toBe(T0 + 6)
      expect(kept?.at(-1)).toBe(T0 + past)
    })

    it('brings a list that grew past the ceiling under it, with nothing new to hand over (review of #250)', async () => {
      // What the fault this fixes left behind: four times the ceiling, and a viewer
      // with nothing waiting, so no fetch will ever trim it.
      const grown = MAX_DELIVERIES_KEPT_PER_VIEWER * 4
      await writeFile(
        path,
        fileOf({
          device,
          viewers: {
            [ann]: {
              ...viewerEntry(receiveKey()),
              fetchedAt: Array.from({ length: grown }, (_, i) => T0 + i),
            },
          },
        }),
      )
      const store = createRelayStore(path)
      // Served under the ceiling at once, before anything is written.
      const served = await times(store, T0 + grown)
      expect(served).toHaveLength(MAX_DELIVERIES_KEPT_PER_VIEWER)
      expect(served?.at(-1)).toBe(T0 + grown - 1)
      // And the hourly expiry writes it so.
      await store.expire(T0 + grown)
      const inFile = JSON.parse(await readFile(path, 'utf8')) as {
        viewers: Record<string, { fetchedAt: number[] }>
      }
      expect(inFile.viewers[ann]!.fetchedAt).toEqual(served)
    })

    it('reads a file from before it kept what was given: what waits is news once', async () => {
      // No envelope says it was given: stream 3 waits above an ack of 2.
      await writeFile(
        path,
        fileOf({
          viewers: {
            [ann]: {
              ...viewerEntry(receiveKey()),
              ackedThrough: 2,
              waiting: [{ ...waiting(3), postedAt: T0 }],
            },
          },
        }),
      )
      const store = createRelayStore(path)
      await store.fetch(ann, T0)
      await store.fetch(ann, T0 + 1)
      expect(await times(store, T0 + 2)).toEqual([T0])
    })

    it('refuses a file whose note on an envelope is not the one this relay writes', async () => {
      await writeFile(
        path,
        fileOf({
          viewers: {
            [ann]: {
              ...viewerEntry(receiveKey()),
              waiting: [{ ...waiting(1), postedAt: T0, given: 'yes' }],
            },
          },
        }),
      )
      await expect(createRelayStore(path).roleOf(ann)).rejects.toThrow(/stream 1 given is not true/)
    })
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

describe('enrolment tokens (reviews of #219)', () => {
  it('keeps one outstanding: a new token voids the last', async () => {
    const store = createRelayStore(path)
    const first = await store.issueToken(T0)
    const second = await store.issueToken(T0)
    const keys = { key: device, receiveKey: receiveKey() }
    expect(await store.redeem(first, keys, T0)).toBe('invalid')
    expect(await store.redeem(second, keys, T0)).toBe('enrolled')
  })
})

describe('an edit that throws, while something expires (second review of #218)', () => {
  it('still writes the expiry', async () => {
    const store = createRelayStore(path)
    await store.issueToken(T0)
    await store.enrolDevice(device, receiveKey(), T0)
    const hashes = () =>
      readFile(path, 'utf8').then((text) => Object.keys(JSON.parse(text).tokens as object))
    expect(await hashes()).toHaveLength(1)
    // Refused, since a device is enrolled — and the token, expired by now, still goes.
    await expect(store.issueToken(T0 + ENROL_TOKEN_TTL_MS)).rejects.toThrow(/recovery card/)
    expect(await hashes()).toEqual([])
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
    // Every key a different key, as `takenBy` holds at every way in (second review of #218).
    ['the device’s two keys one key', fileOf({ device: ann, deviceReceiveKey: ann })],
    [
      'two viewers sharing one receiving key',
      fileOf({
        viewers: {
          [ann]: viewerEntry(SHARED),
          [identity().key]: viewerEntry(SHARED),
        },
      }),
    ],
    [
      'a viewer receiving at the device’s signing key',
      fileOf({ device: DEVICE_KEY, viewers: { [ann]: viewerEntry(DEVICE_KEY) } }),
    ],
    [
      'a pairing joined with the device’s receiving key',
      fileOf({
        device: DEVICE_KEY,
        deviceReceiveKey: DEVICE_RECEIVE,
        pairings: {
          ABCDEFGHJK: { expiresAt: 0, viewer: { key: ann, receiveKey: DEVICE_RECEIVE } },
        },
      }),
    ],
    [
      'an ended viewer’s key held as someone’s receiving key',
      fileOf({ viewers: { [identity().key]: viewerEntry(ann) }, ended: { [ann]: 0 } }),
    ],
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

  it('flushes its file to the disk before renaming it into place (KV-223)', async () => {
    // Without the flush a power cut just after a write can leave the relay's file empty:
    // every enrolled key gone, and every viewer a stranger.
    const store = createRelayStore(path)
    disk.events.length = 0
    await store.enrolDevice(device, receiveKey(), T0)
    const tmp = `${basename(path)}.tmp`
    // Then the folder, where it can be: a rename lost to a power cut would bring back a
    // viewer whose sharing had just been ended (review of #247). Windows has no such flush.
    const folder = process.platform === 'win32' ? [] : [`sync ${basename(dir)}`]
    expect(disk.events).toEqual([`sync ${tmp}`, `rename ${tmp}`, ...folder])
  })

  it.skipIf(process.platform === 'win32')(
    'writes its file for its own user only, a temporary file left by a crash included (KV-226)',
    async () => {
      // Left by a crash, readable by everyone: opened as it is, so it has to be set.
      await writeFile(`${path}.tmp`, 'half', { mode: 0o666 })
      await chmod(`${path}.tmp`, 0o666)
      const store = await enrolled()
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    },
  )

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

  it('reads a file with an ended viewer rejoining by a pairing', async () => {
    // The one place an ended key may appear: their own signing key, coming back (KV-31).
    const file = fileOf({
      device: DEVICE_KEY,
      deviceReceiveKey: DEVICE_RECEIVE,
      ended: { [ann]: 0 },
      pairings: { ABCDEFGHJK: { expiresAt: T0 + 1, viewer: { key: ann, receiveKey: SHARED } } },
    })
    await writeFile(path, file, 'utf8')
    expect(await createRelayStore(path).roleOf(ann)).toBe('ended')
  })

  it('lets no way in enrol keys an open pairing holds (reviews of #218)', async () => {
    // What would let `confirm` enrol over a viewer already there. Closed at every way in,
    // so `confirm`'s own check is defence, not the only thing holding it.
    const store = await enrolled()
    const { pairing } = await store.openPairing(T0)
    const bill = { key: identity().key, receiveKey: receiveKey() }
    expect((await store.join(pairing, bill, T0)).kind).toBe('joined')
    await expect(store.enrolViewer(bill.key, receiveKey(), T0)).rejects.toThrow(/already/)
    await expect(store.enrolViewer(identity().key, bill.receiveKey, T0)).rejects.toThrow(/already/)
    expect(await store.confirm(pairing, T0)).toBe('enrolled')
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
