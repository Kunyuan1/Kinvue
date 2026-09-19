import { describe, expect, it } from 'vitest'
// Type-only, so it is erased and the native runtime is never loaded. The
// values it describes could not be imported here for that reason.
import type { SmartSpectraErrorCodeValue } from '@smartspectra/node-sdk'
import { classifyCaptureError } from '@core/capture/failure'
import {
  CaptureCancelledError,
  MissingApiKeyError,
  captureError,
  sdkErrorCode,
  sdkFailure,
} from '../app/main/capture-errors'

/**
 * `app/main/capture-errors.ts` is the capture's throws, split out of
 * `vitals.ts` so they can be tested here: importing the SDK root loads the
 * native runtime through koffi at import time, and this suite runs with no
 * camera, no key and no runtime.
 *
 * What is pinned is the contract the screens depend on — that every throw
 * carries a tag — rather than the classifier's ability to read strings the
 * test wrote itself (KV-7).
 */

/** The codes this maps, asserted against the SDK's own union at compile time. */
type Mapped = 2 | 3 | 4 | 7
const _codesAreReal: Mapped extends SmartSpectraErrorCodeValue ? true : never = true
void _codesAreReal

describe('the errors the capture throws', () => {
  it('tags a missing API key as setup, not as the camera', () => {
    expect(classifyCaptureError(new MissingApiKeyError())).toBe('no-api-key')
  })

  it('tags a stopped reading as cancelled', () => {
    expect(classifyCaptureError(new CaptureCancelledError())).toBe('cancelled')
  })

  it('tags what captureError builds, and keeps the original as cause', () => {
    const original = new TypeError('koffi exploded')
    const err = captureError('camera-unavailable', 'the camera could not be started.', original)

    expect(classifyCaptureError(err)).toBe('camera-unavailable')
    // The tag has to travel in the message, but the class and stack need not
    // be lost to a log on this side.
    expect(err.cause).toBe(original)
  })

  it('leaves cause unset rather than undefined-valued when there is none', () => {
    expect('cause' in captureError('expired', 'gone.')).toBe(false)
  })
})

describe('sdkFailure', () => {
  it.each([
    [2, 'a rejected, expired or revoked key'],
    [3, 'a configuration the SDK would not take'],
    [4, 'an account out of credit'],
  ])('calls code %i setup rather than a busy camera (%s)', (code) => {
    // The harm this prevents: the person closes the video call they were told
    // about, retries, fails again, and the cause is a .env nobody has touched.
    expect(sdkFailure(code)).toBe('no-api-key')
  })

  it('still calls a genuinely unavailable input the camera', () => {
    expect(sdkFailure(7)).toBe('camera-unavailable')
  })

  it('does not guess at codes it has no opinion about', () => {
    for (const code of [0, 1, 5, 6, 8, 9, 10, 11]) {
      expect(sdkFailure(code)).toBe('camera-unavailable')
    }
  })
})

describe('sdkErrorCode', () => {
  it('reads the numeric code the SDK puts on its errors', () => {
    expect(sdkErrorCode(Object.assign(new Error('nope'), { code: 2 }))).toBe(2)
  })

  it('says nothing when there is no usable code', () => {
    // Missing is not zero: a code of 0 is kOk and must not be confused with
    // "no code was given", which is why this returns undefined rather than 0.
    expect(sdkErrorCode(new Error('plain'))).toBeUndefined()
    expect(sdkErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeUndefined()
    expect(sdkErrorCode(undefined)).toBeUndefined()
    expect(sdkErrorCode('a string')).toBeUndefined()
  })
})
