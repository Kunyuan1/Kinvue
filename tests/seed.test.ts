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

/**
 * What the worst day in the demo sums to today: day 8, `not-eaten` (0.30) and
 * `pulse-elevated` (0.2668 at z ≈ 2.37), against ELEVATED_SEVERITY_THRESHOLD
 * 0.6 — a margin of 0.0332. This is the one place that number lives;
 * `persona.ts` points here rather than restating it.
 */
const WORST_DAY_TODAY = 0.5668

/**
 * The fortnight the app actually seeds: `demo:seed` calls `seedDemoHistory()`
 * with no length, so neither does this.
 */
const seeded = seedDemoHistory(undefined, AT)

/**
 * Each seeded day scored against the days before it — what the dashboard would
 * show if it scored them. It does not yet: `demo:seed` stores seeded records
 * with no assessment. The path that does run today, a real capture scored
 * against the seeded fortnight, is `scoring.test.ts`'s `seededHistory(12)`.
 */
const scored = seeded.map((s, i) => {
  const assessment = scoreSession(s, seeded.slice(0, i))
  return {
    day: i,
    assessment,
    severity: assessment.firedRules.reduce((total, r) => total + r.severity, 0),
  }
})
type ScoredDay = (typeof scored)[number]

const ruleIds = (d: ScoredDay): string => d.assessment.firedRules.map((r) => r.id).join(', ')

/**
 * The worst day among those whose flag the severity sum actually decides. A
 * day behind a baseline under MIN_BASELINE_SESSIONS is `insufficient-signal`
 * whatever it sums to, so the threshold says nothing about it.
 */
function worstDecidedDay(): ScoredDay {
  const decided = scored.filter((d) => d.assessment.baselineSessions >= MIN_BASELINE_SESSIONS)
  const [first, ...rest] = decided
  if (first === undefined) throw new Error('no seeded day has a mature baseline behind it')
  return rest.reduce((a, b) => (b.severity > a.severity ? b : a), first)
}

describe('the seeded demo history', () => {
  it('never scores a day as elevated', () => {
    // The property the demo actually needs, and the one `persona.ts` now
    // claims. The stronger reading of the old comment — that no rule fires at
    // all — is false. Three rules fire across the fortnight: `not-eaten` (the
    // 1-in-10 `eatenToday` draw), `low-mood` (MOOD's `low`), and
    // `pulse-elevated`, from the vitals jitter alone clearing `Z_FIRES_AT`
    // against a short, steady baseline. Rules firing is what makes the demo
    // look like a person rather than a flat line; a day reading `elevated` is
    // what would make it look like an emergency.
    for (const d of scored) {
      expect(
        d.assessment.flag,
        `day ${d.day} summed to ${d.severity.toFixed(4)}; rules [${ruleIds(d)}]`,
      ).not.toBe('elevated')
    }
  })

  it('sits exactly as far from the threshold as WORST_DAY_TODAY records', () => {
    // Asserting only "not elevated" would pass at 0.599, and that is not what
    // the ticket is protecting — the risk is a *quiet* drift into a demo that
    // looks alarming.
    //
    // This records the margin rather than endorsing it. It is thin, and
    // widening it means changing the seeded answer weights — a change to what
    // the demo shows, which wants its own decision (#101). It is pinned both
    // ways: narrower is the drift this exists to catch, and wider without
    // updating WORST_DAY_TODAY would leave this file describing a demo that
    // no longer exists, which is how the comment KV-14 replaced went wrong.
    const worst = worstDecidedDay()
    expect(
      worst.severity,
      `day ${worst.day} now sums to ${worst.severity.toFixed(4)}, a margin of ` +
        `${(ELEVATED_SEVERITY_THRESHOLD - worst.severity).toFixed(4)} against ` +
        `${ELEVATED_SEVERITY_THRESHOLD}; rules [${ruleIds(worst)}]. If that is ` +
        `intended, update WORST_DAY_TODAY`,
    ).toBeCloseTo(WORST_DAY_TODAY, 4)
  })

  it('produces a capture the scorer is willing to use, every day', () => {
    // What makes the demo work at all: a seeded day that failed the capture
    // gate would be dropped from its own baseline (KV-72) and show "not enough
    // to say" on a card built to demonstrate a comparison.
    for (const s of seeded) {
      expect(unusableReason(s.vitals), s.id).toBeNull()
    }
  })

  it('is still learning their normal on the first three days only', () => {
    // The history exists so the dashboard can be shown with a baseline behind
    // it, and the floor matters as much as the ceiling: every day spent below
    // MIN_BASELINE_SESSIONS is a "Still learning their normal" card. Pinned by
    // day rather than derived from the constant, so that raising the constant
    // — or shortening the default fortnight — fails here instead of quietly
    // greying out more of the demo.
    const learning = scored.filter((d) => d.assessment.flag === 'insufficient-signal')
    expect(learning.map((d) => d.day)).toEqual([0, 1, 2])

    const baseline = computeBaseline(seeded.slice(0, -1))
    expect(baseline.seededSessions).toBe(baseline.sessions)
    expect(baseline.pulseRateBpm).not.toBeNull()
  })

  it('is identical on every run', () => {
    // The mulberry32 PRNG exists for exactly this. Two installs, or one
    // install re-seeded, must not disagree about Margaret's fortnight.
    expect(seedDemoHistory(undefined, AT)).toEqual(seeded)
  })

  it('does not depend on the day it happens to be generated', () => {
    // Only the dates move with `endingAt`; the readings and answers are drawn
    // from the seed, and the zone is the host's. A demo shown in January must
    // be the same person as one shown in September.
    const january = seedDemoHistory(undefined, new Date('2027-01-05T09:00:00.000Z'))

    expect(january.map((s) => s.vitals)).toEqual(seeded.map((s) => s.vitals))
    expect(january.map((s) => s.answers)).toEqual(seeded.map((s) => s.answers))
    expect(january.map((s) => s.timeZone)).toEqual(seeded.map((s) => s.timeZone))
    expect(january.map((s) => s.capturedAt)).not.toEqual(seeded.map((s) => s.capturedAt))
  })

  it('marks every record as seeded and as the demo person', () => {
    // KV-8's disclosure rests on this: `seeded: true` is what the dashboard
    // labels and what `computeBaseline` counts for KV-53.
    for (const s of seeded) {
      expect(s.seeded, s.id).toBe(true)
      expect(s.personId, s.id).toBe(DEMO_PERSON_ID)
    }
  })
})
