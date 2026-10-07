import { describe, expect, it } from 'vitest'
import { exportOf, planRestore } from '@core/session/lifecycle'
import {
  isProtected,
  MIN_PASSPHRASE_LENGTH,
  protect,
  PROTECTED_EXPORT_VERSION,
  unprotect,
  type ProtectedExport,
} from '@core/session/protect'
import { session } from './helpers'

/**
 * A passphrase-protected export (KV-175, T16). scrypt at its real cost takes
 * about a second, so these run slower than the rest, and are few.
 */

const SLOW = { timeout: 30_000 }
const NOW = new Date('2026-10-07T12:00:00.000Z')
const file = exportOf(
  {
    sessions: [session({ id: 'a', answers: { painReported: true, painNote: 'left hip' } })],
    removed: [],
  },
  'test-person',
  NOW,
)
const PASSPHRASE = 'blue kettle morning'

describe('protect and unprotect', () => {
  it('opens with its passphrase to the export exactly, readable to no one else', SLOW, async () => {
    const sealed = await protect(file, PASSPHRASE)
    expect(sealed).toMatchObject({ kind: 'kinvue-history', version: PROTECTED_EXPORT_VERSION })
    expect(JSON.stringify(sealed)).not.toContain('left hip')
    expect(JSON.stringify(sealed)).not.toContain('test-person')
    expect(isProtected(JSON.parse(JSON.stringify(sealed)))).toBe(true)
    expect(await unprotect(sealed, PASSPHRASE)).toEqual({
      ok: true,
      contents: JSON.parse(JSON.stringify(file)),
    })
  })

  it('does not open with another passphrase, or once a byte has changed', SLOW, async () => {
    const sealed = await protect(file, PASSPHRASE)
    expect(await unprotect(sealed, 'blue kettle evening')).toEqual({
      ok: false,
      why: 'wrong-passphrase',
    })
    const bytes = Buffer.from(sealed.sealed, 'base64')
    bytes[0] = bytes[0]! ^ 1
    const changed = { ...sealed, sealed: bytes.toString('base64') }
    expect(await unprotect(changed, PASSPHRASE)).toEqual({ ok: false, why: 'wrong-passphrase' })
  })

  it('does not open with its header changed, which the tag covers', SLOW, async () => {
    const sealed = await protect(file, PASSPHRASE)
    const weaker = { ...sealed, protection: { ...sealed.protection, N: 2 ** 14 } }
    expect(await unprotect(weaker, PASSPHRASE)).toEqual({ ok: false, why: 'wrong-passphrase' })
  })

  it('refuses a header that asks for more than it may, before spending on it', async () => {
    const crafted = (N: number, r: number, p: number): ProtectedExport => ({
      kind: 'kinvue-history',
      version: PROTECTED_EXPORT_VERSION,
      protection: {
        kdf: 'scrypt',
        N,
        r,
        p,
        salt: 'AA==',
        cipher: 'aes-256-gcm',
        iv: 'AA==',
        tag: 'AA==',
      },
      sealed: 'AA==',
    })
    // Each within any one parameter's reach, and too costly together (review
    // of #187): N = 2^20, r = 32 took two minutes and 3.5 GB. Refused at once,
    // or this test would time out rather than pass.
    for (const [N, r, p] of [
      [2 ** 30, 8, 1],
      [2 ** 20, 32, 1],
      [2 ** 17, 8, 16],
      [2 ** 20, 8, 1],
      [2 ** 32, 1, 1],
    ] as const) {
      expect(await unprotect(crafted(N, r, p), PASSPHRASE)).toMatchObject({
        ok: false,
        why: 'unreadable',
      })
    }
  })

  it('still opens a file made at up to four times its own cost', SLOW, async () => {
    // Forward room: a later build may raise the cost. Here the header is the
    // app's own with r doubled — the tag fails, so it reaches scrypt and the
    // passphrase check, and is not refused for its cost.
    const sealed = await protect(file, PASSPHRASE)
    const raised = { ...sealed, protection: { ...sealed.protection, r: 16 } }
    expect(await unprotect(raised, PASSPHRASE)).toEqual({ ok: false, why: 'wrong-passphrase' })
  })

  it('opens with its keys in another order, as a sorting formatter leaves it', SLOW, async () => {
    const sealed = await protect(file, PASSPHRASE)
    const sort = (o: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? 1 : -1)))
    const sorted = sort({ ...sealed, protection: sort({ ...sealed.protection }) })
    expect(Object.keys(sorted.protection as object)).not.toEqual(Object.keys(sealed.protection))
    expect((await unprotect(sorted as unknown as ProtectedExport, PASSPHRASE)).ok).toBe(true)
  })

  it('reads a passphrase typed in either Unicode form as the same one', SLOW, async () => {
    const composed = 'café au lait'
    const decomposed = 'café au lait'
    const sealed = await protect(file, composed)
    expect((await unprotect(sealed, decomposed)).ok).toBe(true)
  })

  it('refuses a passphrase too short to be the whole defence', async () => {
    await expect(protect(file, 'x'.repeat(MIN_PASSPHRASE_LENGTH - 1))).rejects.toThrow(
      /at least 8 characters/,
    )
  })

  it('is refused as newer, not no export, by a restore with no protection', SLOW, async () => {
    // The container keeps its kind (review of #186): planRestore alone, as a
    // build before KV-175 has it, says something true about a file Kinvue made.
    const sealed = JSON.parse(JSON.stringify(await protect(file, PASSPHRASE))) as unknown
    const plan = planRestore({ sessions: [], removed: [] }, 'test-person', sealed)
    expect(plan).toEqual({ ok: false, refusal: { kind: 'newer', of: 'export', version: 2 } })
  })
})
