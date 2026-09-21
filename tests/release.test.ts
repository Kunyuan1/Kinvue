import { describe, expect, it, vi } from 'vitest'
import {
  askedForCaptureLog,
  awaitRelease,
  DEVICE_RELEASE_TIMEOUT_MS,
  releaseLogLine,
  RELEASE_LOG_ENV,
} from '../app/main/release'

/**
 * The lock a capture holds is what makes `capture-in-progress` honest, and it
 * is only honest if it outlives the device (KV-84). What must not happen is a
 * teardown turning into the capture's error, or into a lock nobody can clear.
 */
describe('awaitRelease', () => {
  it('reports a device that closed', async () => {
    expect(await awaitRelease(Promise.resolve())).toBe('released')
  })

  it('reports a teardown that failed rather than throwing it', async () => {
    // A good reading must not become an error because the camera took an odd
    // route to closing. The old code swallowed this entirely.
    const outcome = await awaitRelease(Promise.reject(new Error('destroy failed')))
    expect(outcome).toBe('failed')
  })

  it('gives up on a teardown that never finishes', async () => {
    vi.useFakeTimers()
    try {
      const pending = awaitRelease(new Promise(() => undefined), 2000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(await pending).toBe('timed-out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait out the window when the device closes early', async () => {
    vi.useFakeTimers()
    try {
      const pending = awaitRelease(Promise.resolve(), 60_000)
      // No timer advanced: a resolved teardown must settle on its own.
      await expect(pending).resolves.toBe('released')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves no timer holding the process open after it settles', async () => {
    vi.useFakeTimers()
    try {
      await awaitRelease(Promise.resolve(), 60_000)
      // In Electron's main process a stray timer is the difference between
      // quitting and appearing to hang.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('has a bound short enough to be a wait rather than a stall', () => {
    // Deliberately a guess, and deliberately short: #63 owns the constants.
    expect(DEVICE_RELEASE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEVICE_RELEASE_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })
})

/**
 * The number behind `DEVICE_RELEASE_TIMEOUT_MS` has to come from hardware, and
 * until KV-84 the outcome was returned and dropped so nobody could see it.
 */
describe('releaseLogLine', () => {
  it('says nothing about a clean release nobody asked about', () => {
    expect(releaseLogLine('released', 120, false)).toBeNull()
  })

  it('reports the timing when the run asked for it', () => {
    const line = releaseLogLine('released', 120, true)
    expect(line).toContain('120ms')
    expect(line).toContain('released')
  })

  it('speaks up about a camera that failed to close even unasked', () => {
    // The next capture would blame this on another program having the camera,
    // which is the sentence KV-7 exists to stop the app guessing at.
    expect(releaseLogLine('failed', 30, false)).toContain('failed')
  })

  it('speaks up about a camera that outran the wait, and names the bound', () => {
    const line = releaseLogLine('timed-out', DEVICE_RELEASE_TIMEOUT_MS, false)
    expect(line).not.toBeNull()
    expect(line).toContain(String(DEVICE_RELEASE_TIMEOUT_MS))
  })
})

describe('askedForCaptureLog', () => {
  it('is off unless the variable is set to something', () => {
    expect(askedForCaptureLog({})).toBe(false)
    expect(askedForCaptureLog({ [RELEASE_LOG_ENV]: '' })).toBe(false)
  })

  it('is on for any non-empty value', () => {
    expect(askedForCaptureLog({ [RELEASE_LOG_ENV]: '1' })).toBe(true)
    expect(askedForCaptureLog({ [RELEASE_LOG_ENV]: 'yes' })).toBe(true)
  })
})
