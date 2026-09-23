import type { Assessment, SessionRecord, SleepAnswer, MoodAnswer } from '../session/types'
import { scoreSession, totalSeverity } from '../scoring'

/**
 * A pre-seeded history for the demo persona (KV-8).
 *
 * This exists for one reason: the app compares a reading against a person's own
 * baseline, a baseline needs weeks of check-ins, and a new install has none. This
 * history lets the dashboard be developed and shown with a baseline behind it.
 *
 * This is disclosed, not hidden. Every record it produces carries
 * `seeded: true`, the dashboard labels them, and README.md and ARCHITECTURE.md
 * say so.
 *
 * The disclosure covers the verdict too. The dashboard records every capture
 * against DEMO_PERSON_ID, so a real capture taken after seeding is compared
 * with this invented history; `computeBaseline` counts how many of the sessions
 * behind a comparison were seeded, and the scorer says so in the summary and on
 * the card (KV-53). See ARCHITECTURE.md, "Why the demo history is seeded".
 */

export const DEMO_PERSON_ID = 'demo-margaret'
export const DEMO_PERSON_NAME = 'Margaret'

/** Margaret's invented normal — steady, unremarkable, a little low on HRV for her age. */
const USUAL = {
  pulseRateBpm: 72,
  breathingRateBrpm: 15,
  hrvRmssdMs: 34,
  hrvSdnnMs: 42,
} as const

/** mulberry32 — a deterministic PRNG so the demo history is identical on every run. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * No seeded day may have rules summing to this or more (KV-101). A day that
 * does is drawn again.
 *
 * Below `ELEVATED_SEVERITY_THRESHOLD` (0.6) by a deliberate margin rather than
 * at it. Verdicts are computed when shown (`withSeededVerdicts`), but the redraw
 * happens when the fortnight is seeded — so a demo seeded under today's scorer
 * is judged by every later one. At 0.6 the default fortnight kept a 0.03 margin
 * and a later weight change could turn a stored demo amber; at 0.5 every seeded
 * day starts at least 0.1 clear, twice the lightest rule.
 */
export const DEMO_DAY_CEILING = 0.5
// Also, deliberately, exactly `notEaten` + `lowMood` (0.3 + 0.2), the heaviest
// answers-only day without pain, so that day never appears in the demo. If
// either weight moves, this ceiling no longer sits on that line; decide again.

/** How many times a day may be redrawn before seeding gives up rather than keep it. */
const MAX_REDRAWS = 100

const SLEEP: readonly SleepAnswer[] = ['well', 'well', 'ok', 'ok', 'poorly']
const MOOD: readonly MoodAnswer[] = ['good', 'good', 'ok', 'ok', 'low']

function pick<T>(items: readonly T[], r: number): T {
  // items is never empty at any call site; the ?? keeps noUncheckedIndexedAccess happy.
  return items[Math.floor(r * items.length)] ?? (items[0] as T)
}

/**
 * Build `days` of ordinary check-ins ending the day before `endingAt`, so the
 * history reads as the fortnight leading up to today.
 */
export function seedDemoHistory(
  days = 12,
  endingAt: Date = new Date(),
  seed = 20260915,
): SessionRecord[] {
  // The invented days are laid out with setDate/setHours, which are host-local,
  // so the zone stamped on them has to be the host's too. Taking one as a
  // parameter would let a caller label 09:15 here as 09:15 somewhere else, and
  // every seeded day would land on the wrong date (KV-28).
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const r = rng(seed)
  const out: SessionRecord[] = []

  for (let i = days; i >= 1; i--) {
    const at = new Date(endingAt)
    at.setDate(at.getDate() - i)
    at.setHours(9, 15, 0, 0)

    // Small day-to-day wobble around USUAL.
    //
    // This used to say "nothing here should trip a rule", which was never
    // true and nothing checked (KV-14). Rules fire on most of these days, and
    // they should: MOOD holds `low`, SLEEP holds `poorly`, some days go
    // un-eaten, and a wobble this wide clears `Z_FIRES_AT` against a short
    // baseline. A demo where nothing ever registers reads as a flat line, not
    // as a person.
    //
    // The odds below are what is *drawn*, not what the demo shows: the redraw
    // after them rejects heavy days, and the heaviest answers most. Over 3600
    // days, un-eaten is drawn 10% and kept 7.4%; pain drawn 15%, kept 13.4%.
    // So narrowing a draw here buys no safety — the ceiling already provides
    // it — and costs variety. How close the worst day comes is recorded in the
    // test, as WORST_DAY_TODAY, and nowhere else.
    //
    // The property that matters is weaker and load-bearing: **no seeded day
    // may score `elevated`.** Unremarkable weeks, not an emergency in front of
    // an audience. Until KV-101 that held by luck: across 2000 seeds, 18.4% of
    // fortnights had an elevated day, and this seed's worst sat 0.03 below the
    // line. Now it holds by construction — a day whose rules reach
    // DEMO_DAY_CEILING is drawn again — and `tests/seed.test.ts` checks it
    // across seeds, not only this one.
    const jitter = (spread: number): number => (r() - 0.5) * 2 * spread

    const draw = (): SessionRecord => ({
      id: `seed-${DEMO_PERSON_ID}-${i}`,
      personId: DEMO_PERSON_ID,
      capturedAt: at.toISOString(),
      timeZone,
      seeded: true,
      vitals: {
        pulseRateBpm: Math.round(USUAL.pulseRateBpm + jitter(4)),
        breathingRateBrpm: Math.round(USUAL.breathingRateBrpm + jitter(1.5)),
        hrvRmssdMs: Math.round(USUAL.hrvRmssdMs + jitter(4)),
        hrvSdnnMs: Math.round(USUAL.hrvSdnnMs + jitter(5)),
        confidence: 0.82 + r() * 0.12,
        stable: true,
        durationSec: 30,
      },
      answers: {
        mood: pick(MOOD, r()),
        sleep: pick(SLEEP, r()),
        eatenToday: r() > 0.1,
        painReported: r() > 0.85,
      },
    })

    // Scored against the days already drawn, as `withSeededVerdicts` will score
    // it when shown. Redraws continue the same PRNG stream, so the fortnight is
    // still identical on every run.
    let day = draw()
    for (let redraws = 0; totalSeverity(scoreSession(day, out)) >= DEMO_DAY_CEILING; redraws++) {
      if (redraws === MAX_REDRAWS) {
        throw new Error(
          `seed ${seed}: day ${days - i} (seed-${DEMO_PERSON_ID}-${i}) still reached ` +
            `${DEMO_DAY_CEILING} after ${MAX_REDRAWS} redraws. Keeping it would put an ` +
            'amber card in the demo.',
        )
      }
      day = draw()
    }
    out.push(day)
  }

  return out
}

/**
 * The records to show, with every seeded one carrying the verdict the scorer
 * gives it *now* (KV-103). Real records are returned untouched.
 *
 * Seeded records are stored without a verdict and scored here, when they are
 * shown, rather than when they are written. A real check-in's stored verdict is
 * a fact about a day and is never rescored. A seeded record is generated data,
 * and its verdict is a view of the current rules: stored, it would go stale the
 * first time a weight moved, and the demo would show a scorer the app no longer
 * has. Scoring on display also reaches installs that seeded before this existed,
 * which a stored verdict could not without a migration.
 *
 * Each seeded record is scored the way `submit` scores a real one — against the
 * records before it in time, never itself. Input order is kept.
 */
export function withSeededVerdicts(records: readonly SessionRecord[]): SessionRecord[] {
  const byTime = [...records].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const verdicts = new Map<string, Assessment>()
  byTime.forEach((record, i) => {
    if (record.seeded === true) verdicts.set(record.id, scoreSession(record, byTime.slice(0, i)))
  })
  return records.map((record) => {
    const assessment = verdicts.get(record.id)
    return assessment === undefined ? record : { ...record, assessment }
  })
}
