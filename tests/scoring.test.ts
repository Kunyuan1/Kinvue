import { describe, expect, it } from 'vitest'
import { MIN_BASELINE_SESSIONS } from '@core/baseline'
import {
  hasScorableVitals,
  MIN_CAPTURE_SECONDS,
  scoreSession,
  seededBaselineDisclosure,
  unusableReason,
} from '@core/scoring'
import type { Assessment } from '@core/session/types'
import { ALL_RULES, BASELINE_RULE_IDS } from '@core/scoring'
import { history, seededHistory, session } from './helpers'

const ids = (a: Assessment): string[] => a.firedRules.map((r) => r.id)

describe('scoreSession', () => {
  it('is normal when nothing deviates', () => {
    const assessment = scoreSession(session(), history(5))
    expect(assessment.flag).toBe('normal')
    expect(assessment.firedRules).toEqual([])
  })

  it('withholds a verdict until there is enough history for a baseline', () => {
    const assessment = scoreSession(session(), history(MIN_BASELINE_SESSIONS - 1))
    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.summary).toContain('Still learning their normal')
  })

  it('still shows answer-based rules while the baseline is building', () => {
    const assessment = scoreSession(
      session({ answers: { eatenToday: false } }),
      history(MIN_BASELINE_SESSIONS - 1),
    )
    expect(assessment.flag).toBe('insufficient-signal')
    expect(ids(assessment)).toContain('not-eaten')
  })

  it('does not score a capture the SDK reported with low confidence', () => {
    const assessment = scoreSession(session({ vitals: { confidence: 0.2 } }), history(5))
    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.summary).toContain('not clear enough')
  })

  it('does not score a capture that was cut short', () => {
    const assessment = scoreSession(
      session({ vitals: { durationSec: MIN_CAPTURE_SECONDS - 1 } }),
      history(5),
    )
    expect(assessment.flag).toBe('insufficient-signal')
  })

  it('fires hrv-drop with the numbers in the explanation', () => {
    // Baseline HRV is 34; 20 is a ~41% drop, past the 25% trigger.
    const assessment = scoreSession(session({ vitals: { hrvRmssdMs: 20 } }), history(5))
    expect(ids(assessment)).toContain('hrv-drop')
    const rule = assessment.firedRules.find((r) => r.id === 'hrv-drop')
    expect(rule?.explanation).toContain('20 ms')
    expect(rule?.explanation).toContain('34 ms')
  })

  it('flags the combination the product exists to catch', () => {
    // HRV drop + poor sleep + pain, the worked example from the brief.
    const assessment = scoreSession(
      session({
        vitals: { hrvRmssdMs: 20 },
        answers: { sleep: 'poorly', painReported: true },
      }),
      history(5),
    )
    expect(assessment.flag).toBe('elevated')
    expect(ids(assessment)).toEqual(
      expect.arrayContaining(['hrv-drop', 'poor-sleep-with-pain']),
    )
  })

  it('does not flag a single soft answer-only signal', () => {
    const assessment = scoreSession(session({ answers: { mood: 'low' } }), history(5))
    expect(assessment.flag).toBe('normal')
    expect(ids(assessment)).toEqual(['low-mood'])
  })

  it('reports fired rules even on a normal day', () => {
    const assessment = scoreSession(session({ answers: { eatenToday: false } }), history(5))
    expect(assessment.flag).toBe('normal')
    expect(ids(assessment)).toEqual(['not-eaten'])
  })

  it('does not double-count pain when poor sleep already pairs with it', () => {
    const assessment = scoreSession(
      session({ answers: { sleep: 'poorly', painReported: true } }),
      history(5),
    )
    expect(ids(assessment)).toContain('poor-sleep-with-pain')
    expect(ids(assessment)).not.toContain('pain-reported')
  })

  it('orders fired rules by severity, strongest first', () => {
    const assessment = scoreSession(
      session({
        vitals: { hrvRmssdMs: 15 },
        answers: { mood: 'low', eatenToday: false },
      }),
      history(5),
    )
    const severities = assessment.firedRules.map((r) => r.severity)
    expect([...severities].sort((a, b) => b - a)).toEqual(severities)
  })

  it('carries the seeded count on the assessment', () => {
    const assessment = scoreSession(session(), seededHistory(12))
    expect(assessment.flag).toBe('normal')
    expect(assessment.baselineSeededSessions).toBe(12)
    // The sentence is composed where it is shown, not frozen into the record.
    expect(assessment.summary).not.toContain('seeded')
  })

  it('counts only the seeded part of a mixed baseline', () => {
    const assessment = scoreSession(session(), [...seededHistory(10), ...history(2)])
    expect(assessment.baselineSeededSessions).toBe(10)
    expect(assessment.baselineSessions).toBe(12)
  })

  it('still withholds a verdict when a seeded baseline is too thin to use', () => {
    const assessment = scoreSession(session(), seededHistory(MIN_BASELINE_SESSIONS - 1))
    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.baselineSeededSessions).toBe(MIN_BASELINE_SESSIONS - 1)
  })

  it('withholds a verdict on a reading nothing rated', () => {
    // A rate can arrive with no confidence and no stable flag at all. Scoring
    // it would present a number as reliable because nothing contradicted it,
    // which is the reassuring direction and the wrong one (KV-12).
    const assessment = scoreSession(session({ vitals: { confidence: null } }), history(5))

    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.summary).toContain('did not say how reliable')
  })

  it('treats a confidence the record never carried as unrated', () => {
    // `store.ts` casts parsed JSON to SessionRecord without validating it, so a
    // record missing the key reads as undefined rather than null. `undefined <
    // MIN_CAPTURE_CONFIDENCE` is false, so a strict null check would score it as
    // fully vouched-for — the exact failure KV-12 closes.
    const record = session()
    delete (record.vitals as { confidence?: number | null }).confidence
    const assessment = scoreSession(record, history(5))

    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.summary).toContain('did not say how reliable')
  })

  it('still scores a record written before confidence could be null', () => {
    // A pre-KV-12 record carries a number and never null. The null handling must
    // not have changed what those records do.
    const assessment = scoreSession(session({ vitals: { confidence: 0.9 } }), history(5))

    expect(assessment.flag).toBe('normal')
    expect(assessment.summary).not.toContain('camera')
  })

  it('does not call an empty capture unrated', () => {
    // Nothing measured is its own thing; "the camera did not say how reliable
    // this reading was" would be describing a reading that does not exist — and
    // so would "not clear enough to use", which is what this used to borrow.
    const nothing = { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null }
    const assessment = scoreSession(
      session({ vitals: { ...nothing, confidence: null } }),
      history(5),
    )

    expect(assessment.summary).toContain('no reading came out of it')
    expect(assessment.summary).not.toContain('not clear enough')
    expect(assessment.summary).not.toContain('did not say how reliable')
  })

  it('names the short capture rather than the reading it cut off', () => {
    // A capture stopped early can also arrive unrated. The duration is the one
    // thing the person in front of the camera could have done differently, and
    // it is why the reading is thin — so it is the reason worth giving.
    const assessment = scoreSession(
      session({ vitals: { durationSec: MIN_CAPTURE_SECONDS - 12, confidence: null } }),
      history(5),
    )

    expect(assessment.summary).toContain('long enough')
    expect(assessment.summary).not.toContain('did not say how reliable')
  })

  it('tells the caregiver what every unusable capture means for the day', () => {
    // Three of these described the failure and stopped; only the unrated one
    // said what followed from it. The consequence is the part a caregiver acts
    // on, so each sentence carries it.
    const nothing = { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null }
    const cases = [
      session({ vitals: { ...nothing, confidence: null } }),
      session({ vitals: { durationSec: MIN_CAPTURE_SECONDS - 1 } }),
      session({ vitals: { confidence: null } }),
      session({ vitals: { confidence: 0.2 } }),
    ]

    for (const s of cases) {
      expect(scoreSession(s, history(5)).summary).toContain('today is not being compared')
    }
  })

  it('does not compare against a usual it does not have yet', () => {
    // The card used to withhold the comparison and make it in consecutive
    // sentences: "1 of 3 check-ins needed before daily comparisons start",
    // then "Breathing was 16 breaths/min, above their usual 15" (KV-71).
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 16 } }), history(1))

    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.summary).toContain('comparisons start')
    expect(assessment.firedRules).toEqual([])
  })

  it('runs the answer rules while the baseline is building, and says so truthfully', () => {
    // The sentence has always claimed the answer rules are what still ran.
    // Until KV-71 every rule ran; now the claim is true.
    const assessment = scoreSession(
      session({ vitals: { breathingRateBrpm: 16 }, answers: { eatenToday: false } }),
      history(1),
    )

    expect(assessment.firedRules.map((r) => r.id)).toEqual(['not-eaten'])
  })

  it('starts comparing on the check-in that makes the baseline mature', () => {
    // The suppression is exactly as wide as MIN_BASELINE_SESSIONS, not wider.
    const thin = scoreSession(
      session({ vitals: { breathingRateBrpm: 16 } }),
      history(MIN_BASELINE_SESSIONS - 1),
    )
    const mature = scoreSession(
      session({ vitals: { breathingRateBrpm: 16 } }),
      history(MIN_BASELINE_SESSIONS),
    )

    expect(thin.firedRules).toEqual([])
    expect(mature.firedRules.map((r) => r.id)).toContain('breathing-elevated')
  })

  it('does not call one reading a usual, however many sessions there were', () => {
    // `baseline.sessions` counts sessions that produced *some* reading, and a
    // capture routinely produces some vitals and not others. Three sessions can
    // back a pulse mean and a single breathing reading, and the card would
    // quote "their usual 15 breaths/min" off one morning (KV-71).
    const past = [
      session({ id: 'h-0', capturedAt: '2026-09-01T09:00:00.000Z' }),
      session({
        id: 'h-1',
        capturedAt: '2026-09-02T09:00:00.000Z',
        vitals: { breathingRateBrpm: null },
      }),
      session({
        id: 'h-2',
        capturedAt: '2026-09-03T09:00:00.000Z',
        vitals: { breathingRateBrpm: null },
      }),
    ]
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 16 } }), past)

    expect(assessment.baselineSessions).toBe(3)
    expect(ids(assessment)).not.toContain('breathing-elevated')
  })

  it('still compares the metrics that do have a usual on the same history', () => {
    // The gate is per metric, not a blanket suppression: on the history above,
    // pulse has three readings and breathing has one.
    const past = [
      session({ id: 'h-0', capturedAt: '2026-09-01T09:00:00.000Z' }),
      session({
        id: 'h-1',
        capturedAt: '2026-09-02T09:00:00.000Z',
        vitals: { breathingRateBrpm: null },
      }),
      session({
        id: 'h-2',
        capturedAt: '2026-09-03T09:00:00.000Z',
        vitals: { breathingRateBrpm: null },
      }),
    ]
    const assessment = scoreSession(
      session({ vitals: { breathingRateBrpm: 16, pulseRateBpm: 90 } }),
      past,
    )

    expect(ids(assessment)).toContain('pulse-elevated')
    expect(ids(assessment)).not.toContain('breathing-elevated')
  })

  it('does not let a one-reading usual push a day to elevated', () => {
    // The severity is not cosmetic: 0.333 alongside not-eaten's 0.3 clears
    // ELEVATED_SEVERITY_THRESHOLD, so a usual built from one morning could
    // decide the verdict.
    const past = [
      session({ id: 'h-0', capturedAt: '2026-09-01T09:00:00.000Z' }),
      session({
        id: 'h-1',
        capturedAt: '2026-09-02T09:00:00.000Z',
        vitals: { breathingRateBrpm: null },
      }),
      session({
        id: 'h-2',
        capturedAt: '2026-09-03T09:00:00.000Z',
        vitals: { breathingRateBrpm: null },
      }),
    ]
    const assessment = scoreSession(
      session({ vitals: { breathingRateBrpm: 16 }, answers: { eatenToday: false } }),
      past,
    )

    expect(assessment.flag).toBe('normal')
    expect(ids(assessment)).toEqual(['not-eaten'])
  })

  it('does not let the scored session contaminate its own baseline', () => {
    const past = history(5)
    const before = scoreSession(session({ vitals: { hrvRmssdMs: 20 } }), past)
    const after = scoreSession(session({ vitals: { hrvRmssdMs: 20 } }), past)
    expect(before).toEqual(after)
    expect(past).toHaveLength(5)
  })
})

describe('hasScorableVitals', () => {
  // The renderer offers a retake on this predicate and the scorer withholds a
  // verdict on it. They were two copies of the same three fields; these pin
  // them to one, so a capture the scorer would score can never be shown to the
  // person as "nothing was measured".
  it('agrees with the scorer about a capture that measured nothing', () => {
    const nothing = { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null }
    expect(hasScorableVitals(session({ vitals: nothing }).vitals)).toBe(false)
    expect(scoreSession(session({ vitals: nothing }), history(5)).flag).toBe(
      'insufficient-signal',
    )
  })

  it('counts a capture that produced only one of the three', () => {
    const onlyBreathing = { pulseRateBpm: null, hrvRmssdMs: null }
    expect(hasScorableVitals(session({ vitals: onlyBreathing }).vitals)).toBe(true)
    expect(scoreSession(session({ vitals: onlyBreathing }), history(5)).flag).not.toBe(
      'insufficient-signal',
    )
  })

  it('does not count SDNN, which no rule reads', () => {
    const onlySdnn = {
      pulseRateBpm: null,
      breathingRateBrpm: null,
      hrvRmssdMs: null,
      hrvSdnnMs: 42,
    }
    expect(hasScorableVitals(session({ vitals: onlySdnn }).vitals)).toBe(false)
  })
})

describe('seededBaselineDisclosure', () => {
  it('names all of a wholly seeded baseline behind a verdict', () => {
    const note = seededBaselineDisclosure(scoreSession(session(), seededHistory(12)))
    expect(note).toContain('seeded demo data')
    expect(note).toContain('all 12')
  })

  it('names how many of a mixed baseline were seeded', () => {
    const note = seededBaselineDisclosure(
      scoreSession(session(), [...seededHistory(10), ...history(2)]),
    )
    expect(note).toContain('10 of the 12')
  })

  it('says nothing when the baseline is all measured', () => {
    expect(seededBaselineDisclosure(scoreSession(session(), history(5)))).toBeNull()
  })

  it('discloses on an elevated verdict too, not only a calm one', () => {
    const note = seededBaselineDisclosure(
      scoreSession(
        session({ vitals: { hrvRmssdMs: 15 }, answers: { sleep: 'poorly', painReported: true } }),
        seededHistory(12),
      ),
    )
    expect(note).toContain('seeded demo data')
  })

  it('has no rule quoting their usual to disclose while the baseline is thin', () => {
    // This pinned the opposite until KV-71: hrv-drop fired against a two-session
    // seeded baseline and its explanation cited an invented "usual", so the card
    // had to disclose. A rule that quotes their usual no longer runs before
    // there is a usual, so the situation needing disclosure cannot arise.
    const assessment = scoreSession(session({ vitals: { hrvRmssdMs: 20 } }), seededHistory(2))
    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.firedRules.map((r) => r.id)).not.toContain('hrv-drop')
    expect(seededBaselineDisclosure(assessment)).toBeNull()
  })

  it('still discloses once the baseline is mature enough to be quoted', () => {
    // The disclosure itself is untouched: the moment a rule can quote their
    // usual, the card says whose usual it is.
    const assessment = scoreSession(session({ vitals: { hrvRmssdMs: 20 } }), seededHistory(3))
    expect(assessment.firedRules.map((r) => r.id)).toContain('hrv-drop')
    expect(seededBaselineDisclosure(assessment)).toContain('seeded demo data')
  })

  it('says nothing when the capture was unusable, because nothing was compared', () => {
    const assessment = scoreSession(session({ vitals: { confidence: 0.2 } }), seededHistory(12))
    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.firedRules).toEqual([])
    expect(seededBaselineDisclosure(assessment)).toBeNull()
  })

  it('says nothing when only answer-based rules fired under a thin baseline', () => {
    const assessment = scoreSession(
      session({ answers: { eatenToday: false } }),
      seededHistory(2),
    )
    expect(assessment.firedRules.map((r) => r.id)).toEqual(['not-eaten'])
    expect(seededBaselineDisclosure(assessment)).toBeNull()
  })

  it('derives the disclosure set from the flag the rules already carry', () => {
    // Two hand-kept encodings of "quotes their usual" — `usesBaseline` gating
    // suppression and `BASELINE_RULE_IDS` gating disclosure — agreed by hand
    // with nothing checking they still would. A fourth comparison rule added
    // with the flag and forgotten from the list would suppress correctly, so
    // every thin-baseline test would pass, and then quote an invented usual on
    // a mature seeded baseline with no disclosure (KV-71).
    const flagged = ALL_RULES.filter((rule) => rule.usesBaseline === true).map((r) => r.id)

    expect(flagged.length).toBeGreaterThan(0)
    expect([...BASELINE_RULE_IDS].sort()).toEqual([...flagged].sort())
  })

  it('still discloses on a record scored before rules were gated', () => {
    // `restsOnBaseline`'s second branch is unreachable for anything scored now,
    // and load-bearing for stored history: a pre-KV-71 record can carry a rule
    // quoting a usual it should not have had, and the disclosure is composed
    // where the card is shown rather than frozen into the record. Built as a
    // literal because `scoreSession` can no longer produce one.
    const older: Assessment = {
      flag: 'insufficient-signal',
      firedRules: [
        {
          id: 'hrv-drop',
          title: 'Heart-rate variability below usual',
          explanation: 'HRV was 20 ms today, about 41% below their usual 34 ms.',
          severity: 0.4,
        },
      ],
      summary: 'Still learning their normal — 2 of 3 check-ins needed before daily comparisons start.',
      baselineSessions: 2,
      baselineSeededSessions: 2,
    }

    expect(seededBaselineDisclosure(older)).toContain('seeded demo data')
  })

  it('reports an older record as unrecorded rather than as none', () => {
    // Missing is not zero: a session scored before KV-53 has no count, and
    // reading that as "no seeded data" is the defect this ticket closes.
    const scored = scoreSession(session(), history(5))
    const { baselineSeededSessions: _absent, ...older } = scored
    expect(seededBaselineDisclosure(older)).toContain('not recorded')
  })
})

/**
 * Exported so the capture can ask the scorer whether a reading would be
 * accepted, rather than restating the gates and drifting from them (KV-63).
 */
describe('unusableReason', () => {
  it('accepts a capture the scorer would score', () => {
    expect(unusableReason(session().vitals)).toBeNull()
  })

  it('names a capture too short to score', () => {
    // The gate an early stop can now reach, which a fixed clock could not.
    expect(
      unusableReason(session({ vitals: { durationSec: MIN_CAPTURE_SECONDS - 1 } }).vitals),
    ).toBe('too-short')
  })

  it('names a capture the SDK rated poorly', () => {
    expect(unusableReason(session({ vitals: { confidence: 0.2 } }).vitals)).toBe(
      'low-confidence',
    )
  })

  it('names a capture nothing rated', () => {
    expect(unusableReason(session({ vitals: { confidence: null } }).vitals)).toBe('unrated')
  })

  it('names a capture that measured nothing, ahead of anything else', () => {
    const nothing = { pulseRateBpm: null, breathingRateBrpm: null, hrvRmssdMs: null }
    expect(unusableReason(session({ vitals: { ...nothing, durationSec: 1 } }).vitals)).toBe(
      'nothing-measured',
    )
  })

  it('is what scoreSession itself uses, so a caller cannot drift from it', () => {
    // Every unusable shape must produce insufficient-signal, and every usable
    // one must not — otherwise the capture could stop on a reading the scorer
    // then discards.
    const cases = [
      session(),
      session({ vitals: { durationSec: MIN_CAPTURE_SECONDS - 1 } }),
      session({ vitals: { confidence: 0.2 } }),
      session({ vitals: { confidence: null } }),
    ]
    for (const s of cases) {
      const scored = scoreSession(s, history(5))
      expect(scored.flag === 'insufficient-signal').toBe(unusableReason(s.vitals) !== null)
    }
  })
})
