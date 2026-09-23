import { describe, expect, it } from 'vitest'
import { MIN_BASELINE_SESSIONS, computeBaseline } from '@core/baseline'
import {
  ELEVATED_SEVERITY_THRESHOLD,
  scoreSession,
  totalSeverity,
  unusableReason,
} from '@core/scoring'
import {
  DEMO_DAY_CEILING,
  DEMO_PERSON_ID,
  seedDemoHistory,
  withSeededVerdicts,
} from '@core/seed/persona'
import { session } from './helpers'

/**
 * The demo persona's invented fortnight (KV-8), as the dashboard shows it:
 * stored without verdicts, and given the current scorer's verdict when shown
 * (KV-103). These tests read what `withSeededVerdicts` hands the dashboard, not
 * a sweep of their own (KV-14).
 *
 * `persona.ts` used to claim "nothing here should trip a rule". It does — see
 * the test below — and nothing checked, so a seed or weights change could have
 * produced a demo full of fired rules, discovered in front of an audience
 * rather than in CI.
 */
const AT = new Date('2026-09-20T09:00:00.000Z')

/**
 * What the worst day in the demo sums to today: day 8, `pulse-elevated`
 * (0.2668 at z ≈ 2.37) and `poor-sleep` (0.05), against
 * ELEVATED_SEVERITY_THRESHOLD 0.6 — a margin of 0.2832. This is the one place
 * that number lives; `persona.ts` points here rather than restating it.
 *
 * Until KV-101 day 8 was `not-eaten` + `pulse-elevated` at 0.5668, a margin of
 * 0.0332 that fell out of the seed and was smaller than `poor-sleep` itself.
 * That day now reaches DEMO_DAY_CEILING and is drawn again. The margin is no
 * longer luck: no seeded day can start above the ceiling, and the test after
 * next checks that across seeds, not only this one.
 */
const WORST_DAY_TODAY = 0.3168

/**
 * The fortnight the app actually seeds: `demo:seed` calls `seedDemoHistory()`
 * with no length, so neither does this.
 */
const seeded = seedDemoHistory(undefined, AT)

/** Each seeded day with the verdict the dashboard renders for it. */
const shown = withSeededVerdicts(seeded)

// A plain map: a day with no verdict fails the first test below, by name,
// rather than stopping the file from loading and taking every other test with it.
const scored = shown.map((s, i) => ({
  day: i,
  assessment: s.assessment,
  severity: s.assessment === undefined ? 0 : totalSeverity(s.assessment),
}))
type ScoredDay = (typeof scored)[number]

const ruleIds = (d: ScoredDay): string =>
  d.assessment?.firedRules.map((r) => r.id).join(', ') ?? '(no verdict)'

/**
 * The worst day among those whose flag the severity sum actually decides. A
 * day behind a baseline under MIN_BASELINE_SESSIONS is `insufficient-signal`
 * whatever it sums to, so the threshold says nothing about it.
 */
function worstDecidedDay(): ScoredDay {
  const decided = scored.filter(
    (d) => (d.assessment?.baselineSessions ?? 0) >= MIN_BASELINE_SESSIONS,
  )
  const [first, ...rest] = decided
  if (first === undefined) throw new Error('no seeded day has a mature baseline behind it')
  return rest.reduce((a, b) => (b.severity > a.severity ? b : a), first)
}

describe('the seeded demo history', () => {
  it('shows every day with the verdict a real check-in on it would get', () => {
    // KV-103: seeded records carry no verdict, and the dashboard rendered all
    // twelve as "Not enough to say". Each is now scored as it is shown, against
    // the days before it and never itself — the rule `submit` follows.
    shown.forEach((s, i) => {
      expect(s.assessment, `day ${i}`).toEqual(scoreSession(seeded[i]!, seeded.slice(0, i)))
    })
  })

  it('stores no verdict, so none can go stale', () => {
    // A seeded verdict is a view of the current rules, not a fact about a day.
    // Stored, it would keep showing the old scorer after a weight moved.
    for (const s of seeded) expect(s.assessment, s.id).toBeUndefined()
  })

  it('replaces a verdict a seeded record already carries, and leaves real ones alone', () => {
    // An install seeded before KV-103 has no verdicts; one seeded by a build
    // that stored them could have stale ones. Either way the current scorer
    // decides. A real check-in's stored verdict is history and is never redone.
    const stale = seeded.map((s) => ({ ...s, assessment: { ...shown[0]!.assessment! } }))
    const real = session({ id: 'real', capturedAt: '2026-09-21T09:00:00.000Z' })
    real.assessment = { ...shown[0]!.assessment!, summary: 'stored when it was scored' }

    const out = withSeededVerdicts([...stale, real])

    expect(out.slice(0, -1).map((s) => s.assessment)).toEqual(shown.map((s) => s.assessment))
    expect(out.at(-1)).toBe(real)
  })

  it('keeps the order it was given', () => {
    // The dashboard reverses what it is handed; scoring sorts by time internally.
    const reversed = [...seeded].reverse()
    expect(withSeededVerdicts(reversed).map((s) => s.id)).toEqual(reversed.map((s) => s.id))
  })

  it('never scores a day as elevated', () => {
    // The property the demo actually needs, and the one `persona.ts` now
    // claims. The stronger reading of the old comment — that no rule fires at
    // all — is false. Four rules fire across the fortnight: `not-eaten` (the
    // 1-in-10 `eatenToday` draw), `low-mood` (MOOD's `low`), `poor-sleep`
    // (SLEEP's `poorly`, shown but barely weighed — KV-91), and
    // `pulse-elevated`, from the vitals jitter alone clearing `Z_FIRES_AT`
    // against a short, steady baseline. Rules firing is what makes the demo
    // look like a person rather than a flat line; a day reading `elevated` is
    // what would make it look like an emergency.
    for (const d of scored) {
      expect(
        d.assessment?.flag,
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

  it('keeps every day under the ceiling for any seed, not only this one', () => {
    // KV-101: across 2000 seeds, 18.4% of fortnights used to show an elevated
    // day; this seed was one of the lucky ones. The redraw makes it structural,
    // so this checks it where luck would show — other seeds — with the verdicts
    // the dashboard would render.
    for (let seed = 1; seed <= 200; seed++) {
      const days = withSeededVerdicts(seedDemoHistory(undefined, AT, seed))
      days.forEach(({ assessment }, i) => {
        // A day with no verdict would read as 0 and "not elevated", and the
        // ticket's whole guarantee would pass unchecked. Require one first.
        const where = `seed ${seed}, day ${i}`
        expect(assessment, where).toBeDefined()
        if (assessment === undefined) return
        expect(totalSeverity(assessment), where).toBeLessThan(DEMO_DAY_CEILING)
        expect(assessment.flag, where).not.toBe('elevated')
      })
    }
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
    const learning = scored.filter((d) => d.assessment?.flag === 'insufficient-signal')
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
    // The verdict is the one thing computed rather than drawn. A rule that ever
    // reads the date would make January's Margaret a different person.
    expect(withSeededVerdicts(january).map((s) => s.assessment)).toEqual(
      shown.map((s) => s.assessment),
    )
  })

  it('draws exactly this fortnight', () => {
    // Every other determinism test compares the generator with another run of
    // itself, so they agree whatever it consumes. These are literals: anything
    // that starts drawing from the PRNG — scoring included — moves them. A seed
    // change fails here too, deliberately; update the literals with it.
    expect(seeded.map((s) => s.vitals.pulseRateBpm)).toEqual([
      70, 71, 68, 73, 69, 69, 71, 71, 74, 72, 75, 72,
    ])
    expect(seeded.map((s) => s.vitals.breathingRateBrpm)).toEqual([
      15, 16, 15, 15, 14, 14, 16, 16, 15, 16, 14, 14,
    ])
    expect(seeded.map((s) => s.vitals.hrvRmssdMs)).toEqual([
      30, 32, 34, 33, 36, 33, 35, 35, 34, 34, 34, 38,
    ])
    expect(
      seeded.map(({ answers: a }) =>
        [a.sleep, a.mood, a.eatenToday ? 'ate' : 'not-eaten', a.painReported ? 'pain' : '']
          .filter(Boolean)
          .join(' '),
      ),
    ).toEqual([
      'well good not-eaten',
      'ok ok not-eaten',
      'poorly good ate',
      'ok ok ate',
      'well good ate',
      'well good ate',
      'ok low ate',
      'well good ate',
      'poorly good ate',
      'poorly low ate',
      'well good ate',
      'well low ate',
    ])
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
