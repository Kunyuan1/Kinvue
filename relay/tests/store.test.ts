import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function enrolled() {
  const store = createRelayStore(path)
  await store.enrolDevice(device, T0)
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
    await store.fetch(ann, T0)
    const before = await store.deliveries(T0 + DELIVERY_RETENTION_MS - 1)
    expect(before.viewers[0]?.fetchedAt).toEqual([T0])
    const after = await store.deliveries(T0 + DELIVERY_RETENTION_MS)
    expect(after.viewers[0]?.fetchedAt).toEqual([])
  })

  it('writes the expiry, so a restart does not bring an expired envelope back', async () => {
    const store = await enrolled()
    await store.post([{ viewer: ann, stream: 1, sealed: sealed('one') }], T0)
    await store.expire(T0 + ENVELOPE_RETENTION_MS)
    expect(await readFile(path, 'utf8')).not.toContain(sealed('one'))
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
    expect(Object.keys(file).sort()).toEqual(['device', 'ended', 'version', 'viewers'])
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
    [
      'a device that is not a key',
      JSON.stringify({ version: 1, device: 'x', viewers: {}, ended: {} }),
    ],
    [
      'an envelope without its bytes',
      JSON.stringify({
        version: 1,
        device: null,
        viewers: {
          [ann]: {
            receiveKey: receiveKey(),
            enrolledAt: 0,
            ackedThrough: 0,
            waiting: [{ stream: 1, postedAt: 0 }],
            fetchedAt: [],
          },
        },
        ended: {},
      }),
    ],
  ])('refuses a file with %s, and repairs nothing', async (_what, text) => {
    await writeFile(path, text, 'utf8')
    await expect(createRelayStore(path).roleOf(ann)).rejects.toBeInstanceOf(
      UnreadableRelayFileError,
    )
    expect(await readFile(path, 'utf8')).toBe(text)
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
