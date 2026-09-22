import { describe, expect, it } from 'vitest'
import { BASELINE_WINDOW_SESSIONS, computeBaseline, MIN_BASELINE_SESSIONS } from '@core/baseline'
import { seedDemoHistory } from '@core/seed/persona'
import { hasScorableVitals, MIN_CAPTURE_SECONDS, unusableReason } from '@core/session/usable'
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

  it('does not let a bad run delete a baseline that is already established', () => {
    // KV-72 review. The window used to be sliced before the filter, so the
    // trailing 14 records were taken first and *then* the unusable ones
    // dropped. A month of good captures behind 14 refused ones left nothing:
    // `sessions` 0, every stat null, and the card back to "Still learning
    // their normal". The old predicate only ever dropped a capture that
    // measured nothing at all, so the ordering never mattered until this
    // filter could fire on ordinary bad lighting.
    const good = Array.from({ length: 30 }, (_, i) =>
      session({
        id: `g-${i}`,
        capturedAt: new Date(Date.UTC(2026, 6, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: 72 },
      }),
    )
    const refused = Array.from({ length: BASELINE_WINDOW_SESSIONS }, (_, i) =>
      session({
        id: `r-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: 110, confidence: 0.4 },
      }),
    )
    const baseline = computeBaseline([...good, ...refused])

    expect(baseline.sessions).toBe(BASELINE_WINDOW_SESSIONS)
    expect(baseline.pulseRateBpm?.mean).toBe(72)
  })

  it('switches comparison off only when the usable history really is thin', () => {
    // Twelve of the last fourteen unusable was enough to fall under
    // MIN_BASELINE_SESSIONS and stop the daily comparison, which is the one
    // thing the product does.
    const good = Array.from({ length: 30 }, (_, i) =>
      session({
        id: `g-${i}`,
        capturedAt: new Date(Date.UTC(2026, 6, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: 72 },
      }),
    )
    const refused = Array.from({ length: 12 }, (_, i) =>
      session({
        id: `r-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: 110, confidence: 0.4 },
      }),
    )
    expect(computeBaseline([...good, ...refused]).sessions).toBeGreaterThanOrEqual(
      MIN_BASELINE_SESSIONS,
    )
  })

  it('never reports fewer check-ins than it did yesterday', () => {
    // "N of 3 check-ins needed" is a count a caregiver watches climb, and a
    // number that can fall gives them no way to read it. Filtering before the
    // window is what makes this true: the window is the trailing 14 *usable*
    // sessions, so a capture that cannot be used displaces nothing (KV-72
    // review, D1). Whether the line should also say *why* the count is lower
    // than their number of attempts is #100 — this only guarantees it is stable.
    const base = history(4)
    let previous = computeBaseline(base).sessions

    for (let i = 0; i < 6; i++) {
      base.push(
        session({
          id: `bad-${i}`,
          capturedAt: new Date(Date.UTC(2026, 9, i + 1, 9)).toISOString(),
          vitals: { confidence: 0.3 },
        }),
      )
      const now = computeBaseline(base).sessions
      expect(now).toBeGreaterThanOrEqual(previous)
      previous = now
    }
    expect(previous).toBe(4)
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

  it('is narrower than the filter it replaced, never wider', () => {
    // The property, not one instance of it: whatever the old filter excluded,
    // the new one must still exclude. `unusableReason` opens on
    // `!hasScorableVitals`, so this holds by construction — and it stops
    // holding the moment someone reorders those branches, which is the thing
    // worth catching (KV-72 review). Asserting it over one blank session only
    // repeated a case the suite already pins above.
    const shapes: Partial<Parameters<typeof hasScorableVitals>[0]>[] = [
      { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null },
      { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null, hrvSdnnMs: 42 },
      { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null, confidence: 0.99 },
      { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null, durationSec: 300 },
      { pulseRateBpm: 72 },
      { breathingRateBrpm: 15, confidence: 0.2 },
    ]
    for (const override of shapes) {
      const { vitals } = session({ vitals: override })
      const label = JSON.stringify(override)
      if (!hasScorableVitals(vitals)) {
        expect(unusableReason(vitals), label).not.toBeNull()
      }
    }
  })
})
