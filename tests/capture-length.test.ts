import { describe, expect, it } from 'vitest'
import { MIN_CAPTURE_SECONDS } from '@core/scoring'
import {
  captureSeconds,
  CAPTURE_SECONDS_ENV,
  DEFAULT_CAPTURE_SECONDS,
  LONGEST_REASONABLE_SECONDS,
  SHORTEST_USEFUL_SECONDS,
} from '../app/main/capture-length'

const withValue = (value: string): NodeJS.ProcessEnv => ({ [CAPTURE_SECONDS_ENV]: value })

describe('captureSeconds', () => {
  it('is the default when nothing asks for anything else', () => {
    expect(captureSeconds({})).toBe(DEFAULT_CAPTURE_SECONDS)
    expect(captureSeconds(withValue(''))).toBe(DEFAULT_CAPTURE_SECONDS)
    expect(captureSeconds(withValue('   '))).toBe(DEFAULT_CAPTURE_SECONDS)
  })

  it('takes a number that was asked for', () => {
    expect(captureSeconds(withValue('45'))).toBe(45)
    expect(captureSeconds(withValue('60'))).toBe(60)
  })

  it('falls back rather than throwing on nonsense', () => {
    // A typo in an env var must not stop the app recording a check-in.
    expect(captureSeconds(withValue('abc'))).toBe(DEFAULT_CAPTURE_SECONDS)
    expect(captureSeconds(withValue('NaN'))).toBe(DEFAULT_CAPTURE_SECONDS)
    expect(captureSeconds(withValue('Infinity'))).toBe(DEFAULT_CAPTURE_SECONDS)
  })

  it('clamps rather than rejects, because the intent is still readable', () => {
    // Someone who writes 200 wants a long capture, not the default.
    expect(captureSeconds(withValue('5'))).toBe(SHORTEST_USEFUL_SECONDS)
    expect(captureSeconds(withValue('9999'))).toBe(LONGEST_REASONABLE_SECONDS)
  })

  it('never returns a length the scorer would reject as too short', () => {
    // MIN_CAPTURE_SECONDS is what `core/scoring` gates on, and a capture also
    // loses a few seconds to the camera opening. A setting that cannot produce
    // a scoreable check-in is not a setting worth honouring.
    for (const value of ['1', '10', '20', '24', '-5']) {
      expect(captureSeconds(withValue(value))).toBeGreaterThan(MIN_CAPTURE_SECONDS)
    }
  })

  it('rounds a fractional request to whole seconds', () => {
    expect(captureSeconds(withValue('45.4'))).toBe(45)
    expect(captureSeconds(withValue('45.6'))).toBe(46)
  })
})
