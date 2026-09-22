import { describe, expect, it } from 'vitest'
import { MIN_BASELINE_SESSIONS } from '@core/baseline'
import {
  hasScorableVitals,
  MIN_CAPTURE_SECONDS,
  scoreSession,
  seededBaselineDisclosure,
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

  it('says how far out a z-rule reading is, not just that it is out', () => {
    // "Pulse was 75 bpm, above their usual 72 bpm" invites "three beats, so
    // what?" when the point is that three beats is a lot for them. hrv-drop
    // never had this problem because a percentage carries its own magnitude.
    const past = [72, 78, 69, 81, 75].map((pulse, i) =>
      session({
        id: `h-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: pulse },
      }),
    )
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 95 } }), past)
    const rule = assessment.firedRules.find((r) => r.id === 'pulse-elevated')

    expect(rule?.explanation).toContain('95 bpm')
    expect(rule?.explanation).toContain('75 bpm')
    // The spread, which is what makes 95 checkable rather than assertable.
    // 4.7, not "5": the clause prints one decimal place so that a real spread
    // below 0.5 cannot render as "about 0" (KV-11 review).
    expect(rule?.explanation).toMatch(/vary by about 4\.7 bpm/i)
  })

  it('does not quote a spread the floor invented', () => {
    // On an unvarying baseline `Stat.sd` is 0 and MIN_SD_FRACTION_OF_MEAN
    // becomes the scale. Reporting that back as "they usually vary by about
    // 1.4 bpm" would present a floor as a measurement — a number nobody
    // produced, which is the one thing this scorer must never do.
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 75 } }), history(5))
    const rule = assessment.firedRules.find((r) => r.id === 'pulse-elevated')

    expect(rule?.explanation).toBeDefined()
    expect(rule?.explanation).not.toMatch(/vary by about/i)
    expect(rule?.explanation).toMatch(/barely varied/i)
    // And it stops there rather than concluding from the floor. The code has
    // never observed this person vary, so it cannot know that three beats is
    // large for them — asserting it is the same overstatement as quoting the
    // floored sd, one level up (KV-11 review).
    expect(rule?.explanation).not.toMatch(/a large one for them/i)
    expect(rule?.explanation).toMatch(/nothing to measure this difference against/i)
    // "usual" belongs to the mean in the first sentence. Spending it again on
    // the spread reads as a contradiction rather than a distinction.
    expect(rule?.explanation).toMatch(/above their usual 72 bpm/i)
    expect(rule?.explanation?.match(/usual/gi)).toHaveLength(1)
  })

  it('reports a measured spread finer than a whole unit instead of "about 0"', () => {
    // Baseline [15, 15, 15, 16, 15] → mean 15.2, sd 0.447, floor 0.304. The
    // floor is *not* active: this is the branch that reports a real spread,
    // and at 0 decimal places it reported it as "about 0 breaths/min either
    // way" — a sentence denying the very spread the rule fired on. Reachable
    // for any mean at or below 25, i.e. breathing rate in every normal range
    // (KV-11 review). Pulse was safe only because its floor is already >= 1.44.
    const past = [15, 15, 15, 16, 15].map((breathing, i) =>
      session({
        id: `h-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { breathingRateBrpm: breathing },
      }),
    )
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 17 } }), past)
    const rule = assessment.firedRules.find((r) => r.id === 'breathing-elevated')

    expect(rule?.explanation).toBeDefined()
    expect(rule?.explanation).not.toMatch(/vary by about 0 /i)
    expect(rule?.explanation).toMatch(/vary by about 0\.4 breaths\/min/i)
  })

  it('does not quote a spread the floor invented when the sd is real but under it', () => {
    // `history(5)` is identical readings, so sd is exactly 0 and the `<`
    // comparison never met a non-zero sd below the floor — `usual.sd === 0`
    // passed the entire suite (KV-11 review). Pulse [72, 72, 72, 72, 74] has
    // sd 0.89 against a floor of 1.45: a real spread the floor still supplants.
    const past = [72, 72, 72, 72, 74].map((pulse, i) =>
      session({
        id: `h-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: pulse },
      }),
    )
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 76 } }), past)
    const rule = assessment.firedRules.find((r) => r.id === 'pulse-elevated')

    expect(rule?.explanation).toBeDefined()
    expect(rule?.explanation).not.toMatch(/vary by about/i)
    expect(rule?.explanation).toMatch(/nothing to measure this difference against/i)
  })

  it('agrees with itself about the scale when the floor supplies it', () => {
    // The severity comes from the floored sd; the sentence used to decide
    // which wording to use by recomputing the floor independently. One
    // `spreadOf` now feeds both, so they cannot describe different scales.
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 75 } }), history(5))
    const rule = assessment.firedRules.find((r) => r.id === 'pulse-elevated')

    expect(rule?.explanation).toMatch(/nothing to measure this difference against/i)
    expect(rule?.severity).toBeGreaterThan(0)
  })

  it('says "breath/min" when the spread is exactly one', () => {
    // Baseline [14, 14, 15, 16, 16] → mean 15, sd exactly 1.0. "about 1
    // breaths/min either way" is routine for this clause in a way it never
    // was for the first sentence (KV-11 review).
    const past = [14, 14, 15, 16, 16].map((breathing, i) =>
      session({
        id: `h-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { breathingRateBrpm: breathing },
      }),
    )
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 18 } }), past)
    const rule = assessment.firedRules.find((r) => r.id === 'breathing-elevated')

    expect(rule?.explanation).toContain('about 1 breath/min either way')
  })

  it('names the metric from its own field, not from the first word of its title', () => {
    // `title.split(' ')[0]` worked only because every title began with its
    // noun. "Unusually fast breathing" would have read "Unusually was 40".
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 30 } }), history(5))
    const rule = assessment.firedRules.find((r) => r.id === 'breathing-elevated')

    expect(rule?.explanation).toMatch(/^Breathing was /)
    expect(rule?.title).toBe('Breathing above usual')
  })

  it('leaves hrv-drop saying what it already said well', () => {
    // A percentage already carries its own magnitude, so it needs no spread.
    const assessment = scoreSession(session({ vitals: { hrvRmssdMs: 20 } }), history(5))
    const rule = assessment.firedRules.find((r) => r.id === 'hrv-drop')

    expect(rule?.explanation).toContain('%')
    expect(rule?.explanation).not.toMatch(/vary by about|steady/i)
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
