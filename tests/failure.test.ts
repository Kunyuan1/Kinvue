import { describe, expect, it } from 'vitest'
import {
  classifyCaptureError,
  classifyDashboardError,
  classifySubmitError,
  failureDetail,
  failureTag,
  taggedFailure,
  type TaggedFailure,
} from '@core/capture/failure'
import { UnreachableStoreError, UnreadableStoreError } from '@core/session/store'
import { dashboardErrorText } from '@renderer/dashboardError'

/**
 * Three quite different situations used to reach the screen as the same raw
 * error string: no key configured, a camera another program is holding, and a
 * reading that no longer exists. None of the first two is about the person,
 * and only one of the three is about their day (KV-7).
 */

/** What Electron hands back: the original message, wrapped twice over. */
const overIpc = (message: string): Error =>
  new Error(`Error invoking remote method 'checkin:capture': Error: ${message}`)

describe('reading a failure off the wire', () => {
  it('finds the tag inside what IPC wraps around it', () => {
    const thrown = overIpc(`${failureTag('no-api-key')}: SMARTSPECTRA_API_KEY is not set.`)
    expect(classifyCaptureError(thrown)).toBe('no-api-key')
  })

  it.each([
    ['no-api-key'],
    ['camera-unavailable'],
    ['no-connection'],
    ['cancelled'],
    ['capture-in-progress'],
    ['expired'],
    ['no-capture'],
  ] as [TaggedFailure][])('reads %s back off the wire', (failure) => {
    expect(taggedFailure(new Error(`${failureTag(failure)}: something`))).toBe(failure)
  })

  /**
   * Two unions, so a tag belongs to a path (KV-75). A failure the other path
   * raised is `unknown` here rather than a confident wrong sentence — the same
   * answer an untagged throw gets, and for the same reason.
   */
  it.each([['expired'], ['no-capture']] as [TaggedFailure][])(
    'will not show %s on the capture screen, because that path cannot raise it',
    (failure) => {
      expect(classifyCaptureError(new Error(`${failureTag(failure)}: x`))).toBe('unknown')
    },
  )

  it.each([['no-api-key'], ['camera-unavailable'], ['capture-in-progress'], ['cancelled']] as [
    TaggedFailure,
  ][])('will not show %s on the questions screen', (failure) => {
    expect(classifySubmitError(new Error(`${failureTag(failure)}: x`))).toBe('unknown')
  })

  it('routes an unreadable store to its own answer, not to "try again"', () => {
    // The blocker KV-13 review found: `submit` reads history before scoring,
    // so this arrives after the capture ran and all four questions were
    // answered. Untagged it landed in `unknown`, whose copy invites a retry
    // that cannot ever succeed.
    const thrown = new Error(`${failureTag('store-unreadable')}: the file will not parse.`)
    expect(classifySubmitError(thrown)).toBe('store-unreadable')
  })

  it('will not show store-unreadable on the capture screen, which never opens the store', () => {
    expect(
      classifyCaptureError(new Error(`${failureTag('store-unreadable')}: x`)),
    ).toBe('unknown')
  })

  it('says nothing at all for a capture the person stopped', () => {
    // Null, not a sentence: they stopped it, so they know. The old flat union
    // had copy for this that no screen could ever reach.
    expect(classifyCaptureError(new Error(`${failureTag('cancelled')}: stopped.`))).toBeNull()
  })

  it('calls anything untagged unknown rather than guessing', () => {
    for (const thrown of [new Error('ENOENT: no such file'), 'a string', undefined]) {
      expect(classifyCaptureError(thrown)).toBe('unknown')
      expect(classifySubmitError(thrown)).toBe('unknown')
      expect(taggedFailure(thrown)).toBeNull()
    }
  })

  it('takes the outer tag when a message quotes another tagged error', () => {
    // Which one wins used to be the order the tags happened to be listed in.
    // The outer tag is the one the code that threw meant, so position in the
    // text decides, and the list order stops being load-bearing.
    const nested = new Error(
      `${failureTag('camera-unavailable')}: wrapping — ${failureTag('cancelled')}: inner.`,
    )
    expect(taggedFailure(nested)).toBe('camera-unavailable')

    const other = new Error(
      `${failureTag('cancelled')}: wrapping — ${failureTag('camera-unavailable')}: inner.`,
    )
    expect(taggedFailure(other)).toBe('cancelled')
  })

  it('does not depend on the wording after the tag', () => {
    // The point of a tag: the sentence can be rewritten for the person reading
    // it without silently reclassifying the failure.
    const before = new Error(`${failureTag('expired')}: that capture is too old.`)
    const after = new Error(`${failureTag('expired')}: rewritten entirely, in another voice.`)
    expect(classifyCaptureError(before)).toBe(classifyCaptureError(after))
  })
})

describe('the dashboard, when the history will not open (KV-95)', () => {
  const path = String.raw`C:\Users\someone\AppData\Roaming\kinvue\sessions\sessions.json`
  // The real error, wrapped the way Electron delivers a rejected `invoke`:
  // the class name and its message, prefixed with the channel.
  const fromMain = (err: Error, channel = 'sessions:list'): Error =>
    new Error(`Error invoking remote method '${channel}': ${String(err)}`)
  const unreadable = fromMain(new UnreadableStoreError(path, 'it is not valid JSON'))

  it('shows the sentence the store wrote, and nothing wrapped around it', () => {
    const text = dashboardErrorText(unreadable, 'fallback')

    expect(text).toBe(
      `The check-in history at ${path} could not be read: it is not valid JSON. ` +
        'Nothing has been changed. Move the file aside to start fresh.',
    )
    expect(text).not.toMatch(/invoking remote method|UnreadableStoreError|kinvue\//)
  })

  it('does the same when seeding hits the same file', () => {
    // `demo:seed` lists the store before writing, so it can fail identically.
    const seeding = fromMain(new UnreadableStoreError(path, 'it is not valid JSON'), 'demo:seed')
    expect(classifyDashboardError(seeding)).toBe('store-unreadable')
    expect(dashboardErrorText(seeding, 'fallback')).toMatch(/^The check-in history at /)
  })

  it('gives anything it has no words for the plain sentence from the call site', () => {
    // Previously the raw string. The original still goes to the console.
    const other = fromMain(new Error('ENOSPC: no space left on device'))
    expect(classifyDashboardError(other)).toBe('unknown')
    expect(dashboardErrorText(other, 'The check-ins could not be shown.')).toBe(
      'The check-ins could not be shown.',
    )
  })

  it('does not treat a capture tag as a store failure', () => {
    const capture = fromMain(new Error(`${failureTag('camera-unavailable')}: held`))
    expect(classifyDashboardError(capture)).toBe('unknown')
  })

  it('shows the sentence for a file that could not be opened at all, with its code', () => {
    const locked = fromMain(new UnreachableStoreError(path, 'EBUSY', new Error('busy')))
    expect(classifyDashboardError(locked)).toBe('store-unreachable')
    expect(dashboardErrorText(locked, 'fallback')).toBe(
      `The check-in history at ${path} could not be opened (EBUSY). Another program may ` +
        'be using it, or its permissions may need checking. Nothing has been changed.',
    )
  })

  it('stops at the end of the sentence, whatever is appended after it', () => {
    const withStack = new Error(
      `${String(unreadable)}\n    at read (store.ts:160:11)\n    at list (store.ts:210:5)`,
    )
    expect(dashboardErrorText(withStack, 'fallback')).toMatch(/Move the file aside to start fresh\.$/)
  })

  it('falls back to its own sentence, action included, if the tag arrives with none', () => {
    const bare = new Error(`${failureTag('store-unreadable')}: `)
    expect(dashboardErrorText(bare, 'fallback')).toMatch(/Move the file aside to start fresh\./)
  })

  it('reads a tagged sentence out of any wrapping, and says nothing when the tag is absent', () => {
    expect(failureDetail(unreadable, 'store-unreadable')).toMatch(/^The check-in history at /)
    expect(failureDetail(unreadable, 'expired')).toBeNull()
    expect(failureDetail(new Error(`${failureTag('store-unreadable')}: `), 'store-unreadable'))
      .toBeNull()
  })
})
