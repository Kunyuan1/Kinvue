import type { SessionRecord, SleepAnswer, MoodAnswer } from '../session/types'

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
  // The invented days are laid out in the device's own local time, so the zone
  // recorded on them is the device's as well (KV-28). A seeded record with no
  // zone would be the one kind of record the dashboard could not place on a day.
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): SessionRecord[] {
  const r = rng(seed)
  const out: SessionRecord[] = []

  for (let i = days; i >= 1; i--) {
    const at = new Date(endingAt)
    at.setDate(at.getDate() - i)
    at.setHours(9, 15, 0, 0)

    // Small day-to-day wobble around USUAL. Nothing here should trip a rule —
    // this history is meant to read as a person having unremarkable weeks.
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
