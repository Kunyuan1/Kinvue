import { describe, expect, it, vi } from 'vitest'
import { settleOnce, type SealSteps } from '../app/main/seal-loop'

/** One pass of main's seal loop (KV-175, KV-19): the key and the history, apart. */

const steps = (over: Partial<SealSteps> = {}): SealSteps & { log: string[] } => {
  const log: string[] = []
  return {
    log,
    keyLanded: async () => true,
    sealKey: async () => {
      log.push('key')
      return true
    },
    sealHistory: async () => {
      log.push('history')
    },
    historyPlain: async () => false,
    failed: (what) => log.push(`failed ${what}`),
    ...over,
  }
}

describe('settleOnce', () => {
  it('seals nothing before the operating system key is on disk', async () => {
    const s = steps({ keyLanded: async () => false })
    expect(await settleOnce(s)).toBe(false)
    expect(s.log).toEqual([])
  })

  it('seals the key first, then the history, and is done when both are', async () => {
    const s = steps()
    expect(await settleOnce(s)).toBe(true)
    expect(s.log).toEqual(['key', 'history'])
  })

  it('seals the key though the history cannot be read, and says which failed (review of #195)', async () => {
    const sealKey = vi.fn(async () => true)
    const s = steps({
      sealKey,
      sealHistory: async () => {
        throw new Error('UnreadableStoreError: it is not valid JSON')
      },
      historyPlain: async () => true,
    })
    expect(await settleOnce(s)).toBe(false)
    expect(sealKey).toHaveBeenCalled()
    expect(s.log).toEqual(['failed history'])
  })

  it('still tries the history when the key could not be written, and is not done', async () => {
    const s = steps({
      sealKey: async () => {
        throw new Error('EPERM')
      },
    })
    expect(await settleOnce(s)).toBe(false)
    expect(s.log).toEqual(['failed key', 'history'])
  })

  it('is not done while a key is still held in memory', async () => {
    expect(await settleOnce(steps({ sealKey: async () => false }))).toBe(false)
  })
})
