import { describe, expect, it } from 'vitest'
import { BASELINE_WINDOW_SESSIONS, computeBaseline } from '@core/baseline'
import { MIN_CAPTURE_SECONDS } from '@core/scoring'
import { seedDemoHistory } from '@core/seed/persona'
import { history, seededHistory, session } from './helpers'

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

  it('counts how many contributing sessions were seeded', () => {
    // KV-53: a verdict has to be able to say what its "usual" was built from.
    const baseline = computeBaseline([...seededHistory(4), ...history(2)])
    expect(baseline.sessions).toBe(6)
    expect(baseline.seededSessions).toBe(4)
  })

  it('counts no seeded sessions when the history is all measured', () => {
    expect(computeBaseline(history(3)).seededSessions).toBe(0)
  })

  it('does not count a seeded session that contributed nothing', () => {
    const blankSeed = seededHistory(1).map((s) => ({
      ...s,
      vitals: { ...s.vitals, pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null },
    }))
    const baseline = computeBaseline([...blankSeed, ...history(2)])
    expect(baseline.sessions).toBe(2)
    expect(baseline.seededSessions).toBe(0)
  })

  it('ignores sessions whose vitals are all missing', () => {
    const blank = session({
      id: 'blank',
      vitals: { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null },
    })
    expect(computeBaseline([blank, ...history(2)]).sessions).toBe(2)
  })
})

describe('a capture the scorer refused to use', () => {
  // KV-72. `computeBaseline` admitted any session carrying a reading, without
  // asking whether the scorer had been willing to use that capture. So the app
  // declined to show a number on one card — "the camera reading was not clear
  // enough to use today" — and quoted the same number as "their usual" on the
  // next, with nothing connecting them.

  it('does not let a low-confidence capture become their usual', () => {
    // The real pair from the ticket, both dated 2026-09-19: a capture stored
    // with confidence 0.462, and a later breathing reading measured against it.
    const refused = session({
      id: 'refused',
      capturedAt: '2026-09-19T09:00:00.000Z',
      vitals: { breathingRateBrpm: 13, confidence: 0.462 },
    })
    const baseline = computeBaseline([refused, ...history(2, { breathingRateBrpm: 16 })])

    expect(baseline.breathingRateBrpm?.n).toBe(2)
    expect(baseline.breathingRateBrpm?.mean).toBe(16)
  })

  it('does not let a capture cut short become their usual', () => {
    const short = session({
      id: 'short',
      vitals: { hrvRmssdMs: 10, durationSec: MIN_CAPTURE_SECONDS - 1 },
    })
    const baseline = computeBaseline([short, ...history(2, { hrvRmssdMs: 40 })])

    expect(baseline.hrvRmssdMs?.n).toBe(2)
    expect(baseline.hrvRmssdMs?.mean).toBe(40)
  })

  it('does not let an unrated capture become their usual', () => {
    // Unrated is not usable (KV-12): a number nothing vouched for must not
    // become the thing a later number is judged against.
    const unrated = session({ id: 'unrated', vitals: { hrvRmssdMs: 10, confidence: null } })
    const baseline = computeBaseline([unrated, ...history(2, { hrvRmssdMs: 40 })])

    expect(baseline.hrvRmssdMs?.n).toBe(2)
    expect(baseline.hrvRmssdMs?.mean).toBe(40)
  })

  it('does not count it toward the check-ins a caregiver is told to wait for', () => {
    // `Baseline.sessions` drives the "1 of 3 check-ins needed" progress. It
    // counted captures that would never inform a comparison, so the wait was
    // reported as shorter than it was.
    const refused = session({ id: 'refused', vitals: { confidence: 0.2 } })
    expect(computeBaseline([refused, ...history(2)]).sessions).toBe(2)
  })

  it('still admits the seeded demo history, which is the whole demo', () => {
    // Built from `core/seed`, not from the test helper: the filter now runs
    // over records the demo actually writes, and excluding them would empty
    // the persona's baseline and take KV-53's disclosure with it.
    const seeded = seedDemoHistory(12, new Date('2026-09-20T09:00:00.000Z'))
    const baseline = computeBaseline(seeded)

    expect(baseline.sessions).toBe(Math.min(seeded.length, BASELINE_WINDOW_SESSIONS))
    expect(baseline.seededSessions).toBe(baseline.sessions)
    expect(baseline.pulseRateBpm).not.toBeNull()
  })

  it('is narrower than the old test, never wider', () => {
    // `unusableReason` opens with the same "did it measure anything" branch
    // this filter used to be, so nothing that was excluded before is admitted
    // now. Pinned because the two could drift apart silently.
    const blank = session({
      id: 'blank',
      vitals: { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null },
    })
    expect(computeBaseline([blank, ...seededHistory(2)]).sessions).toBe(2)
  })
})
