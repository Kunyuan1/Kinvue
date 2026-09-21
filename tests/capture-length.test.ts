import { describe, expect, it } from 'vitest'
import { MIN_CAPTURE_SECONDS } from '@core/scoring'
import {
  CAMERA_OPEN_ALLOWANCE_SECONDS,
  captureLengthLogLine,
  captureSeconds,
  CAPTURE_SECONDS_ENV,
  DEFAULT_CAPTURE_SECONDS,
  LONGEST_REASONABLE_SECONDS,
  resolveCaptureSeconds,
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

  it('leaves room for the camera to open before the scorer sees the duration', () => {
    // The gate is on the *recorded* duration, which is the setting minus
    // however long the camera took to produce a first frame. Asserting that
    // the setting clears MIN_CAPTURE_SECONDS would pass on a floor that still
    // records too-short captures, which is what a bare 25 did.
    for (const value of ['1', '10', '20', '24', '29', '-5']) {
      const recorded = captureSeconds(withValue(value)) - CAMERA_OPEN_ALLOWANCE_SECONDS
      expect(recorded).toBeGreaterThanOrEqual(MIN_CAPTURE_SECONDS)
    }
  })

  it('keeps the floor tied to the gate rather than to a written-down number', () => {
    // The relationship is the point: raise MIN_CAPTURE_SECONDS and the floor
    // has to move with it, or settings reappear that cannot be scored.
    expect(SHORTEST_USEFUL_SECONDS).toBe(MIN_CAPTURE_SECONDS + CAMERA_OPEN_ALLOWANCE_SECONDS)
  })

  it('rounds a fractional request to whole seconds', () => {
    expect(captureSeconds(withValue('45.4'))).toBe(45)
    expect(captureSeconds(withValue('45.6'))).toBe(46)
  })
})

/**
 * A clamp that rewrites an explicit setting in silence leaves the mismatch
 * between `.env` and the countdown as the only evidence it happened.
 */
describe('captureLengthLogLine', () => {
  it('says nothing when the setting was honoured', () => {
    expect(captureLengthLogLine(resolveCaptureSeconds({}))).toBeNull()
    expect(captureLengthLogLine(resolveCaptureSeconds(withValue('60')))).toBeNull()
  })

  it('names the setting and what is running instead when it was clamped', () => {
    const line = captureLengthLogLine(resolveCaptureSeconds(withValue('10')))
    expect(line).toContain('10')
    expect(line).toContain(String(SHORTEST_USEFUL_SECONDS))
  })

  it('speaks up for a value that could not be read at all', () => {
    const line = captureLengthLogLine(resolveCaptureSeconds(withValue('abc')))
    expect(line).toContain('abc')
    expect(line).toContain(String(DEFAULT_CAPTURE_SECONDS))
  })

  it('reports the ceiling clamp too', () => {
    const line = captureLengthLogLine(resolveCaptureSeconds(withValue('9999')))
    expect(line).toContain(String(LONGEST_REASONABLE_SECONDS))
  })
})
