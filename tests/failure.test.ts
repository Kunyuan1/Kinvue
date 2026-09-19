import { describe, expect, it } from 'vitest'
import { classifyCaptureError, failureTag, type CaptureFailure } from '@core/capture/failure'

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
  ] as [CaptureFailure][])('recognises %s', (failure) => {
    expect(classifyCaptureError(new Error(`${failureTag(failure)}: something`))).toBe(failure)
  })

  it('calls anything untagged unknown rather than guessing', () => {
    expect(classifyCaptureError(new Error('ENOENT: no such file'))).toBe('unknown')
    expect(classifyCaptureError('a string')).toBe('unknown')
    expect(classifyCaptureError(undefined)).toBe('unknown')
  })

  it('takes the outer tag when a message quotes another tagged error', () => {
    // Which one wins used to be the order the tags happened to be listed in.
    // The outer tag is the one the code that threw meant, so position in the
    // text decides, and the list order stops being load-bearing.
    const nested = new Error(
      `${failureTag('camera-unavailable')}: wrapping — ${failureTag('cancelled')}: inner.`,
    )
    expect(classifyCaptureError(nested)).toBe('camera-unavailable')

    const other = new Error(
      `${failureTag('cancelled')}: wrapping — ${failureTag('camera-unavailable')}: inner.`,
    )
    expect(classifyCaptureError(other)).toBe('cancelled')
  })

  it('does not depend on the wording after the tag', () => {
    // The point of a tag: the sentence can be rewritten for the person reading
    // it without silently reclassifying the failure.
    const before = new Error(`${failureTag('expired')}: that capture is too old.`)
    const after = new Error(`${failureTag('expired')}: rewritten entirely, in another voice.`)
    expect(classifyCaptureError(before)).toBe(classifyCaptureError(after))
  })
})
