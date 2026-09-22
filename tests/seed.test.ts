import { describe, expect, it } from 'vitest'
import { MIN_BASELINE_SESSIONS, computeBaseline } from '@core/baseline'
import { ELEVATED_SEVERITY_THRESHOLD, scoreSession, unusableReason } from '@core/scoring'
import { DEMO_PERSON_ID, seedDemoHistory } from '@core/seed/persona'

/**
 * The demo persona's invented fortnight (KV-8), scored the way the dashboard
 * will score it (KV-14).
 *
 * `persona.ts` used to claim "nothing here should trip a rule". It does — see
 * the test below — and nothing checked, so a seed or weights change could have
 * produced a demo full of fired rules, discovered in front of an audience
 * rather than in CI.
 */
const AT = new Date('2026-09-20T09:00:00.000Z')

/** Each seeded day scored against the days before it, as the dashboard does. */
function scoreEachDay(days = 12) {
  const seeded = seedDemoHistory(days, AT)
  return seeded.map((s, i) => {
    const assessment = scoreSession(s, seeded.slice(0, i))
    return {
      day: i,
      record: s,
      assessment,
      severity: assessment.firedRules.reduce((total, r) => total + r.severity, 0),
    }
  })
}

describe('the seeded demo history', () => {
  it('never scores a day as elevated', () => {
    // The property the demo actually needs, and the one `persona.ts` now
    // claims. The stronger reading of the old comment — that no rule fires at
    // all — is false: the answer arrays hold `poorly` and `low`, `eatenToday`
    // is a 1-in-10, `painReported` a 3-in-20, and the vitals jitter alone is
    // enough to clear `Z_FIRES_AT` against a short baseline. Rules firing is
    // what makes the demo look like a person rather than a flat line; a day
    // reading `elevated` is what would make it look like an emergency.
    const scored = scoreEachDay()
    const worst = scored.reduce((a, b) => (b.severity > a.severity ? b : a))

    for (const { day, assessment } of scored) {
      expect(assessment.flag, `day ${day}`).not.toBe('elevated')
    }
    expect(
      worst.severity,
      `day ${worst.day} summed to ${worst.severity.toFixed(2)} against a threshold of ` +
        `${ELEVATED_SEVERITY_THRESHOLD}; rules [${worst.assessment.firedRules
          .map((r) => r.id)
          .join(', ')}]`,
    ).toBeLessThan(ELEVATED_SEVERITY_THRESHOLD)
  })

  it('does not drift any closer to the threshold than it already is', () => {
    // Asserting only "not elevated" would pass at 0.599, and that is not what
    // the ticket is protecting — the risk is a *quiet* drift into a demo that
    // looks alarming. The worst day currently sums to 0.57 against 0.6: three
    // hundredths, roughly one rule weight away.
    //
    // This holds that margin as a floor rather than endorsing it. It is thin,
    // and widening it means changing the seeded answer weights — a change to
    // what the demo shows, which wants its own decision (#101). Until then
    // this fails if anything makes it thinner.
    const worst = scoreEachDay().reduce((a, b) => (b.severity > a.severity ? b : a))
    expect(
      ELEVATED_SEVERITY_THRESHOLD - worst.severity,
      `day ${worst.day} sums to ${worst.severity.toFixed(2)}`,
    ).toBeGreaterThan(0.02)
  })

  it('produces a capture the scorer is willing to use, every day', () => {
    // What makes the demo work at all: a seeded day that failed the capture
    // gate would be dropped from its own baseline (KV-72) and show "not enough
    // to say" on a card built to demonstrate a comparison.
    for (const s of seedDemoHistory(12, AT)) {
      expect(unusableReason(s.vitals), s.id).toBeNull()
    }
  })

  it('has a mature baseline behind the later days, which is the point of it', () => {
    // The history exists so the dashboard can be shown with a baseline behind
    // it. If the fortnight did not clear MIN_BASELINE_SESSIONS the demo would
    // show "Still learning their normal" throughout.
    const seeded = seedDemoHistory(12, AT)
    const baseline = computeBaseline(seeded.slice(0, -1))

    expect(baseline.sessions).toBeGreaterThanOrEqual(MIN_BASELINE_SESSIONS)
    expect(baseline.seededSessions).toBe(baseline.sessions)
    expect(baseline.pulseRateBpm).not.toBeNull()
  })

  it('is identical on every run', () => {
    // The mulberry32 PRNG exists for exactly this. Two installs, or one
    // install re-seeded, must not disagree about Margaret's fortnight.
    expect(seedDemoHistory(12, AT)).toEqual(seedDemoHistory(12, AT))
  })

  it('does not depend on the day it happens to be generated', () => {
    // Only the dates and the recorded zone move with `endingAt`; the readings
    // and answers are drawn from the seed. A demo shown in January must be the
    // same person as one shown in September.
    const september = seedDemoHistory(12, AT)
    const january = seedDemoHistory(12, new Date('2027-01-05T09:00:00.000Z'))

    expect(january.map((s) => s.vitals)).toEqual(september.map((s) => s.vitals))
    expect(january.map((s) => s.answers)).toEqual(september.map((s) => s.answers))
    expect(january.map((s) => s.capturedAt)).not.toEqual(september.map((s) => s.capturedAt))
  })

  it('marks every record as seeded and as the demo person', () => {
    // KV-8's disclosure rests on this: `seeded: true` is what the dashboard
    // labels and what `computeBaseline` counts for KV-53.
    for (const s of seedDemoHistory(12, AT)) {
      expect(s.seeded, s.id).toBe(true)
      expect(s.personId, s.id).toBe(DEMO_PERSON_ID)
    }
  })
})
