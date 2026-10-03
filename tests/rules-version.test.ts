import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeBaseline } from '@core/baseline'
import { ALL_RULES, RULES_VERSION, scoreSession, usualRangeOf } from '@core/scoring'
import type { Assessment, ComparedMetric, SessionRecord, Vitals } from '@core/session/types'
import { session, sessionBeforeKV16 } from './helpers'

/**
 * `RULES_VERSION` moves whenever what the scorer stores moves (KV-30).
 *
 * A fixed set of check-ins is scored, and what comes out is pinned by its
 * hash beside the version it was scored under. Change a threshold, a weight, a
 * rule or a sentence, and the hash changes: this fails until `RULES_VERSION`
 * is bumped and both lines below are updated together. A caregiver reading an
 * old verdict on a viewer's device, which never rescores (KV-32), learns that
 * it came from earlier rules only if this was bumped when they changed.
 *
 * The set is made to straddle each comparison rule's line — a reading just
 * inside, on and just past each edge of the usual range — because a threshold
 * moved by a little shows only there. Lives with refused captures, the old meal
 * question and seeded days cover the rest. All timestamps are UTC, so the hash
 * is the same in every zone.
 */
const PINNED = {
  rulesVersion: 1,
  fingerprint: '88d1f2c1cd913fa6',
}

/** mulberry32: the same check-ins on every run, without fixtures to keep. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const at = (day: number): string => new Date(Date.UTC(2026, 0, 1 + day, 9)).toISOString()
const pick = <T,>(r: number, options: readonly T[]): T => options[Math.floor(r * options.length)]!

/** One case: a check-in and the history it is scored against. */
interface Case {
  session: SessionRecord
  history: readonly SessionRecord[]
}

/** A person's run of days, each scored against the days before it. */
function life(seed: number, days: number): Case[] {
  const r = rng(seed)
  const usual = { pulse: 58 + r() * 30, breathing: 12 + r() * 6, hrv: 18 + r() * 30 }
  const wobble = 0.03 + r() * 0.12
  const records: SessionRecord[] = []
  for (let day = 0; day < days; day++) {
    const around = (centre: number): number =>
      Math.round(centre * (1 + (r() - 0.5) * 4 * wobble))
    const vitals: Partial<Vitals> = {
      pulseRateBpm: around(usual.pulse),
      breathingRateBrpm: around(usual.breathing),
      hrvRmssdMs: r() < 0.15 ? null : around(usual.hrv),
      confidence: 0.75 + r() * 0.2,
    }
    const refused = r()
    if (refused < 0.04) {
      Object.assign(vitals, { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null })
    } else if (refused < 0.08) vitals.durationSec = 6
    else if (refused < 0.11) vitals.confidence = null
    else if (refused < 0.15) vitals.confidence = 0.3
    const answers = {
      mood: pick(r(), ['good', 'ok', 'low'] as const),
      sleep: pick(r(), ['well', 'ok', 'poorly'] as const),
      skippedMeal: r() < 0.15,
      painReported: r() < 0.2,
    }
    const overrides = { id: `life-${seed}-${day}`, capturedAt: at(day), vitals, answers }
    const record = r() < 0.1 ? sessionBeforeKV16(r() < 0.5, overrides) : session(overrides)
    if (seed % 3 === 0 && day < 5) record.seeded = true
    records.push(record)
  }
  return records.map((s, i) => ({ session: s, history: records.slice(0, i) }))
}

const FIELD = { pulse: 'pulseRateBpm', breathing: 'breathingRateBrpm', hrv: 'hrvRmssdMs' } as const

/** A reading near one edge of a metric's usual range. */
interface EdgeCase extends Case {
  metric: ComparedMetric
  edge: 'low' | 'high'
}

/** Readings just inside, on and just past every edge of each metric's usual range. */
function edges(): EdgeCase[] {
  // Seed 7 has no seeded days (only seeds divisible by 3 do), so this is a
  // measured history as it stands; nothing needs filtering out of it.
  const history = life(7, 16).map((c) => c.session)
  const baseline = computeBaseline(history)
  const cases: EdgeCase[] = []
  for (const metric of Object.keys(FIELD) as ComparedMetric[]) {
    const range = usualRangeOf(metric, baseline[FIELD[metric]]!)!
    for (const edge of ['low', 'high'] as const) {
      const line = range[edge]
      if (line === null) continue
      for (const nudge of [-0.004, 0, 0.004]) {
        const value = line * (1 + nudge)
        cases.push({
          metric,
          edge,
          session: session({
            id: `edge-${metric}`,
            capturedAt: at(40),
            vitals: { [FIELD[metric]]: value },
          }),
          history,
        })
      }
    }
  }
  return cases
}

/** Each answer, alone and with the others, against the same settled history. */
function answers(): Case[] {
  const history = life(11, 18).map((c) => c.session)
  const cases: Case[] = []
  for (const mood of ['good', 'ok', 'low'] as const) {
    for (const sleep of ['well', 'ok', 'poorly'] as const) {
      for (const skippedMeal of [false, true]) {
        for (const painReported of [false, true]) {
          const answered = { mood, sleep, skippedMeal, painReported }
          cases.push({
            session: session({ id: 'answers', capturedAt: at(40), answers: answered }),
            history,
          })
        }
      }
    }
  }
  return cases
}

const CASES: Case[] = [
  ...[1, 2, 3, 4, 5, 6].flatMap((seed) => life(seed, 24)),
  ...edges(),
  ...answers(),
]

/** What the scorer stores for each case, less the version the hash is pinned against. */
function scored(): Omit<Assessment, 'rulesVersion'>[] {
  return CASES.map(({ session: s, history }) => {
    const { rulesVersion: _version, ...rest } = scoreSession(s, history)
    return rest
  })
}

const fingerprint = (): string =>
  createHash('sha256').update(JSON.stringify(scored())).digest('hex').slice(0, 16)

describe('RULES_VERSION (KV-30)', () => {
  it('is bumped together with any change to what the scorer stores', () => {
    expect(
      { rulesVersion: RULES_VERSION, fingerprint: fingerprint() },
      'What the scorer stores has changed. If that was meant, bump RULES_VERSION in ' +
        'core/scoring and update PINNED here to the new version and fingerprint, together. ' +
        'If it was not, this is the change to look at.',
    ).toEqual(PINNED)
  })

  it('is written on every verdict', () => {
    for (const { session: s, history } of CASES) {
      expect(scoreSession(s, history).rulesVersion).toBe(RULES_VERSION)
    }
  })

  it('is pinned against a set that exercises every rule, verdict and reason', () => {
    const out = scored()
    const fired = new Set(out.flatMap((a) => a.firedRules.map((rule) => rule.id)))
    for (const rule of ALL_RULES) expect(fired, rule.id).toContain(rule.id)
    expect(new Set(out.map((a) => a.flag))).toEqual(
      new Set(['normal', 'elevated', 'insufficient-signal']),
    )
    expect(new Set(out.map((a) => a.withheld).filter((w) => w !== undefined))).toEqual(
      new Set([
        'nothing-measured',
        'too-short',
        'unrated',
        'low-confidence',
        'still-learning',
        'uncompared',
      ]),
    )
  })

  it('straddles every comparison rule’s line, firing on one side of it only', () => {
    const seen = new Map<string, Set<boolean>>()
    for (const { metric, edge, session: s, history } of edges()) {
      const fires = scoreSession(s, history).firedRules.some(
        (rule) => ALL_RULES.find((r) => r.id === rule.id)?.compares?.metric === metric,
      )
      const side = `${metric} ${edge}`
      seen.set(side, new Set([...(seen.get(side) ?? []), fires]))
    }
    // Pulse and breathing on both sides, HRV below only: nothing fires above it.
    expect([...seen.keys()]).toEqual([
      'pulse low',
      'pulse high',
      'breathing low',
      'breathing high',
      'hrv low',
    ])
    for (const [side, outcomes] of seen) expect([...outcomes].sort(), side).toEqual([false, true])
  })
})
