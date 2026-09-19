import { describe, expect, it } from 'vitest'
import {
  classifyCaptureError,
  classifySubmitError,
  failureTag,
  taggedFailure,
  type TaggedFailure,
} from '@core/capture/failure'

/**
 * Three quite different situations used to reach the screen as the same raw
 * error string: no key configured, a camera another program is holding, and a
 * reading that no longer exists. None of the first two is about the person,
 * and only one of the three is about their day (KV-7).
 */

/** What Electron hands back: the original message, wrapped twice over. */
const overIpc = (message: string): Error =>
  new Error(`Error invoking remote method 'checkin:capture': Error: ${message}`)

describe('classifyCaptureError', () => {
  it('finds the tag inside what IPC wraps around it', () => {
    const thrown = overIpc(`${failureTag('no-api-key')}: SMARTSPECTRA_API_KEY is not set.`)
    expect(classifyCaptureError(thrown)).toBe('no-api-key')
  })

  it.each([
    ['no-api-key'],
    ['camera-unavailable'],
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
