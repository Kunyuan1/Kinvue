import type { Assessment, SessionRecord, SleepAnswer, MoodAnswer } from '../session/types'
import { scoreSession } from '../scoring'

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
    // they should: a tenth of days go un-eaten, MOOD holds `low`, SLEEP holds
    // `poorly`, and a wobble this wide clears `Z_FIRES_AT` against a short
    // baseline. A demo where nothing ever registers reads as a flat line, not
    // as a person.
    //
    // `poorly` weighs lightly (`poor-sleep`, 0.05, KV-91) — more than the
    // worst day's margin, which is why that margin is recorded in the test and
    // not here. The heaviest risk is `poor-sleep-with-pain`: it needs
    // `painReported` too, and that 3-in-20 draw never comes up in the default
    // fortnight — one unlucky draw from firing.
    //
    // The property that matters is weaker and load-bearing: **no seeded day
    // may score `elevated`.** Unremarkable weeks, not an emergency in front of
    // an audience. `tests/seed.test.ts` scores every day against its own
    // predecessors and holds that; how close the worst day comes is recorded
    // there, as WORST_DAY_TODAY, and nowhere else (#101).
    const jitter = (spread: number): number => (r() - 0.5) * 2 * spread

    out.push({
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
