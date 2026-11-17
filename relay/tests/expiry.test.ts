import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVELOPE_RETENTION_MS } from '@kinvue/core/sync/protocol'
import { createRelayServer, EXPIRE_EVERY_MS, expireEvery } from '../server'
import { createRelayStore, type RelayStore } from '../store'
import { identity, receiveKey, sealed } from './helpers'

/**
 * Retention on a timer (second review of #218): reads write nothing, so a relay that has
 * gone quiet would otherwise keep what retention promises to drop.
 */

afterEach(() => {
  vi.useRealTimers()
})

const storeWith = (expire: RelayStore['expire']) => ({ expire }) as unknown as RelayStore

describe('retention on a timer', () => {
  it('runs every hour', () => {
    expect(EXPIRE_EVERY_MS).toBe(60 * 60 * 1000)
  })

  it('expires at each tick, at the relay’s time, until stopped', async () => {
    vi.useFakeTimers()
    const expire = vi.fn(async () => undefined)
    const stop = expireEvery(storeWith(expire), 1000, () => 42)
    await vi.advanceTimersByTimeAsync(3000)
    expect(expire.mock.calls).toEqual([[42], [42], [42]])
    stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(expire).toHaveBeenCalledTimes(3)
  })

  it('leaves a run that failed for the next, rather than stopping', async () => {
    vi.useFakeTimers()
    const expire = vi
      .fn<RelayStore['expire']>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)
    const stop = expireEvery(storeWith(expire), 1000, () => 0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(expire).toHaveBeenCalledTimes(2)
    stop()
  })

  it('tells each run that failed, and the first that works again (KV-225)', async () => {
    // Dropped silently, envelopes stayed past 14 days and fetch times past 30 with
    // nothing anywhere to say so.
    vi.useFakeTimers()
    const expire = vi
      .fn<RelayStore['expire']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
      .mockResolvedValue(undefined)
    const told: string[] = []
    const stop = expireEvery(storeWith(expire), 1000, () => 0, (line) => told.push(line))

    // A run that works says nothing.
    await vi.advanceTimersByTimeAsync(1000)
    expect(told).toEqual([])
    // Each that fails is told, not only the first.
    await vi.advanceTimersByTimeAsync(2000)
    expect(told).toEqual([
      'Retention could not run, so envelopes and fetch times past their time are still kept: ' +
        'ENOSPC: no space left on device. It is tried again within the hour.',
      'Retention could not run, so envelopes and fetch times past their time are still kept: ' +
        'ENOSPC: no space left on device. It is tried again within the hour.',
    ])
    // The first to work again is told once, and the ones after it are quiet.
    await vi.advanceTimersByTimeAsync(3000)
    expect(told.slice(2)).toEqual([
      'Retention ran again: what is past its time has been dropped.',
    ])
    stop()
  })

  it('quotes one line of an error, and not all of a long one', async () => {
    vi.useFakeTimers()
    const expire = vi
      .fn<RelayStore['expire']>()
      .mockRejectedValueOnce(new Error('first line\n    at somewhere (stack)'))
      .mockRejectedValueOnce(new Error('x'.repeat(5000)))
      .mockRejectedValueOnce(new Error(''))
    const told: string[] = []
    const stop = expireEvery(storeWith(expire), 1000, () => 0, (line) => told.push(line))
    await vi.advanceTimersByTimeAsync(3000)
    expect(told[0]).toContain('still kept: first line. It is tried')
    expect(told[0]).not.toContain('stack')
    expect(told[1]!.length).toBeLessThan(500)
    expect(told[2]).toContain('still kept: no reason given. It is tried')
    stop()
  })
})

describe('the relay', () => {
  it('runs retention while nothing else happens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-relay-expiry-'))
    const path = join(dir, 'relay.json')
    try {
      const store = createRelayStore(path)
      const ann = identity().key
      await store.enrolDevice(identity().key, receiveKey(), 0)
      await store.enrolViewer(ann, receiveKey(), 0)
      await store.post([{ viewer: ann, stream: 1, sealed: sealed('old') }], 0)
      vi.useFakeTimers()
      const server = createRelayServer({ store, now: () => ENVELOPE_RETENTION_MS })
      await vi.advanceTimersByTimeAsync(EXPIRE_EVERY_MS)
      vi.useRealTimers()
      // The write is real I/O: give it the turn it needs, then read what is on disk.
      await store.deliveries(ENVELOPE_RETENTION_MS)
      expect(await readFile(path, 'utf8')).not.toContain(sealed('old'))
      server.emit('close')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tells whoever runs it when its own retention run fails (KV-225)', async () => {
    vi.useFakeTimers()
    const expire = vi.fn<RelayStore['expire']>().mockRejectedValue(new Error('disk full'))
    const told: string[] = []
    const server = createRelayServer({
      store: storeWith(expire),
      now: () => 0,
      tell: (line) => told.push(line),
    })
    await vi.advanceTimersByTimeAsync(EXPIRE_EVERY_MS)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatch(/^Retention could not run, .*: disk full\. /)
    server.emit('close')
  })
})
