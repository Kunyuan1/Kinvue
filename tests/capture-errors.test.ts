import { describe, expect, it } from 'vitest'
// Type-only, so it is erased and the native runtime is never loaded. The
// values it describes could not be imported here for that reason.
import type { SmartSpectraErrorCodeValue } from '@smartspectra/node-sdk'
import { classifyCaptureError, taggedFailure } from '@core/capture/failure'
import {
  CaptureCancelledError,
  MissingApiKeyError,
  captureError,
  emptyCaptureFailure,
  sdkErrorCode,
  sdkFailure,
} from '../app/main/capture-errors'
import { session } from './helpers'

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

  it('tags a stopped reading as cancelled, and shows the person nothing', () => {
    // The tag is still emitted — that contract is unchanged, and something
    // reading the wire can tell a stop from a fault. What changed in KV-75 is
    // that the capture screen is given null rather than a sentence: the person
    // pressed stop, so they already know.
    const stopped = new CaptureCancelledError()
    expect(taggedFailure(stopped)).toBe('cancelled')
    expect(classifyCaptureError(stopped)).toBeNull()
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
  const ONLINE = true
  const OFFLINE = false

  it.each([
    [2, 'a rejected, expired or revoked key'],
    [3, 'a configuration the SDK would not take'],
    [4, 'an account out of credit'],
  ])('calls code %i setup rather than a busy camera (%s)', (code) => {
    // The harm this prevents: the person closes the video call they were told
    // about, retries, fails again, and the cause is a .env nobody has touched.
    expect(sdkFailure(code, ONLINE)).toBe('no-api-key')
  })

  it('still calls an account problem an account problem when offline', () => {
    // The SDK only learns a key is bad by reaching Presage, so it was online
    // enough to ask. A stale `isOnline()` must not rewrite that as a
    // connection fault and send someone to check their router (KV-104).
    for (const code of [2, 3, 4]) {
      expect(sdkFailure(code, OFFLINE)).toBe('no-api-key')
    }
  })

  it('still calls a genuinely unavailable input the camera', () => {
    expect(sdkFailure(7, ONLINE)).toBe('camera-unavailable')
  })

  it('does not guess at codes it has no opinion about', () => {
    for (const code of [0, 1, 5, 6, 8, 9, 10, 11]) {
      expect(sdkFailure(code, ONLINE)).toBe('camera-unavailable')
    }
  })

  it('names the connection when the device is offline', () => {
    // Measured on hardware: with the network down the SDK reports code 8,
    // `kProcessingFailed` — the same code a genuinely bad capture gets — so
    // the code cannot carry this. `kNetworkError` (5) never arrives (KV-104).
    for (const code of [5, 6, 8]) {
      expect(sdkFailure(code, OFFLINE), `code ${code}`).toBe('no-connection')
    }
  })

  it('does not let being offline overrule what the SDK found locally', () => {
    // Wi-Fi off and a video call holding the webcam: `start()` throws 7. The
    // connection screen would send them to reconnect, and the next try would
    // tell them about the camera — two trips, the first to the wrong place.
    for (const code of [0, 1, 7, 9, 10, 11]) {
      expect(sdkFailure(code, OFFLINE), `code ${code}`).toBe('camera-unavailable')
    }
  })

  it('does not name the connection for a throw with no code, online or off', () => {
    // The lifecycle path: `useCamera()` throwing carries no numeric code, and
    // selecting an input is local. The measured offline failure was code 8.
    expect(sdkFailure(undefined, ONLINE)).toBe('camera-unavailable')
    expect(sdkFailure(undefined, OFFLINE)).toBe('camera-unavailable')
  })
})

describe('emptyCaptureFailure', () => {
  const NOTHING = session({
    vitals: { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null, hrvSdnnMs: null },
  }).vitals

  it('names the connection when an offline capture ran out its ceiling with nothing', () => {
    // The path the SDK told us nothing on. Without this the person sits
    // through the whole ceiling and reads that no reading came out (KV-104).
    expect(emptyCaptureFailure(NOTHING, false)).toBe('no-connection')
  })

  it('keeps anything that was measured, offline or not', () => {
    // A capture that measured something was not stopped by the connection.
    // It is the scorer's to judge, not this function's to throw away.
    const onePulse = { ...NOTHING, pulseRateBpm: 70 }
    expect(emptyCaptureFailure(onePulse, false)).toBeNull()
    expect(emptyCaptureFailure(session().vitals, false)).toBeNull()
  })

  it('says nothing about an empty capture when the device was online', () => {
    // `true` is inconclusive, so the empty capture is kept and the card says
    // "nothing measured", as it always has.
    expect(emptyCaptureFailure(NOTHING, true)).toBeNull()
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
