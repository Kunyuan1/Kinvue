import { describe, expect, it } from 'vitest'
import { BASELINE_WINDOW_SESSIONS, computeBaseline } from '@core/baseline'
import { history, session } from './helpers'

describe('computeBaseline', () => {
  it('reports no stats and zero sessions for an empty history', () => {
    const baseline = computeBaseline([])
    expect(baseline.sessions).toBe(0)
    expect(baseline.hrvRmssdMs).toBeNull()
  })

  it('averages the readings it is given', () => {
    const baseline = computeBaseline([
      session({ id: 'a', vitals: { hrvRmssdMs: 30 } }),
      session({ id: 'b', vitals: { hrvRmssdMs: 40 } }),
    ])
    expect(baseline.hrvRmssdMs?.mean).toBe(35)
    expect(baseline.hrvRmssdMs?.n).toBe(2)
  })

  it('reports sd 0 for a single reading rather than dividing by zero', () => {
    const baseline = computeBaseline([session({ vitals: { hrvRmssdMs: 30 } })])
    expect(baseline.hrvRmssdMs).toEqual({ mean: 30, sd: 0, n: 1 })
  })

  it('keeps only the trailing window, so an old normal cannot anchor forever', () => {
    const old = history(BASELINE_WINDOW_SESSIONS, { hrvRmssdMs: 10 })
    const recent = Array.from({ length: BASELINE_WINDOW_SESSIONS }, (_, i) =>
      session({
        id: `r-${i}`,
        capturedAt: new Date(Date.UTC(2026, 10, i + 1, 9)).toISOString(),
        vitals: { hrvRmssdMs: 50 },
      }),
    )
    const baseline = computeBaseline([...old, ...recent])
    expect(baseline.sessions).toBe(BASELINE_WINDOW_SESSIONS)
    expect(baseline.hrvRmssdMs?.mean).toBe(50)
  })

  it('ignores sessions whose vitals are all missing', () => {
    const blank = session({
      id: 'blank',
      vitals: { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null },
    })
    expect(computeBaseline([blank, ...history(2)]).sessions).toBe(2)
  })
})
