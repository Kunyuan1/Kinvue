import { describe, expect, it } from 'vitest'
import { MIN_BASELINE_SESSIONS } from '@core/baseline'
import {
  ELEVATED_SEVERITY_THRESHOLD,
  hasScorableVitals,
  MIN_CAPTURE_SECONDS,
  learningStatus,
  staleUsualDisclosure,
  usualReachStatus,
  USUAL_SPAN_NOTE_AFTER_DAYS,
  present,
  presentAll,
  scoreSession,
  seededBaselineDisclosure,
  seededDisclosureFor,
  uncomparedDisclosure,
  unusableReason,
} from '@core/scoring'
import { DEMO_PERSON_ID, seedDemoHistory, withSeededVerdicts } from '@core/seed/persona'
import type { Assessment, SessionRecord } from '@core/session/types'
import { ALL_RULES, BASELINE_RULE_IDS } from '@core/scoring'
import { history, seededHistory, session } from './helpers'

const ids = (a: Assessment): string[] => a.firedRules.map((r) => r.id)

/**
 * Words that say when relative to *now*. Every sentence the scorer writes is
 * frozen into the record and shown under the check-in's date, so none may use
 * one (KV-93).
 */
const RELATIVE_TIME =
  /\b(today|tonight|tomorrow|yesterday|last night|this (morning|afternoon|evening|week)|right now|currently|earlier)\b/i

/** Captures the scorer refuses (low confidence), dated before `history`'s. */
const refusedCaptures = (n: number): SessionRecord[] =>
  Array.from({ length: n }, (_, i) =>
    session({
      id: `refused-${i}`,
      capturedAt: new Date(Date.UTC(2026, 5, i + 1, 9)).toISOString(),
      vitals: { confidence: 0.2 },
    }),
  )

describe('scoreSession', () => {
  it('is normal when nothing deviates', () => {
    const assessment = scoreSession(session(), history(5))
    expect(assessment.flag).toBe('normal')
    expect(assessment.firedRules).toEqual([])
  })

  it('withholds a verdict until there is enough history for a baseline', () => {
    const assessment = scoreSession(session(), history(MIN_BASELINE_SESSIONS - 1))
    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.summary).toBe(
      'Not yet enough history to compare this check-in (2 of 3 usable check-ins before it).',
    )
  })

  it('still shows answer-based rules while the baseline is building', () => {
    const assessment = scoreSession(
      session({ answers: { skippedMeal: true } }),
      history(MIN_BASELINE_SESSIONS - 1),
    )
    expect(assessment.flag).toBe('insufficient-signal')
    expect(ids(assessment)).toContain('skipped-meal')
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
    const assessment = scoreSession(session({ answers: { skippedMeal: true } }), history(5))
    expect(assessment.flag).toBe('normal')
    expect(ids(assessment)).toEqual(['skipped-meal'])
  })

  it('reads a record from before KV-16 by the question it was asked', () => {
    // "Not yet" to "have you eaten today?" still fires, and weighs what it did.
    const before = scoreSession(
      session({ answers: { eatenToday: false, skippedMeal: undefined } }),
      history(5),
    )
    expect(before.firedRules).toEqual([
      expect.objectContaining({ id: 'not-eaten', title: 'Had not eaten yet', severity: 0.3 }),
    ])
    const ate = scoreSession(
      session({ answers: { eatenToday: true, skippedMeal: undefined } }),
      history(5),
    )
    expect(ate.firedRules).toEqual([])
  })

  it('never reads a new record’s missing eaten-today answer as "not yet" (KV-16)', () => {
    // Missing is not zero: a check-in written since KV-16 has no `eatenToday`,
    // and `not-eaten` fired on anything falsy before this change.
    for (const skippedMeal of [false, true]) {
      const a = scoreSession(session({ answers: { skippedMeal } }), history(5))
      expect(ids(a)).not.toContain('not-eaten')
      expect(ids(a).includes('skipped-meal')).toBe(skippedMeal)
    }
  })

  it('does not double-count pain when poor sleep already pairs with it', () => {
    const assessment = scoreSession(
      session({ answers: { sleep: 'poorly', painReported: true } }),
      history(5),
    )
    expect(ids(assessment)).toContain('poor-sleep-with-pain')
    expect(ids(assessment)).not.toContain('pain-reported')
    expect(ids(assessment)).not.toContain('poor-sleep')
  })

  it('shows poor sleep on the card when there is no pain beside it', () => {
    // KV-91: the answer used to vanish — no severity and no line on the card.
    const assessment = scoreSession(session({ answers: { sleep: 'poorly' } }), history(5))
    expect(assessment.flag).toBe('normal')
    expect(ids(assessment)).toEqual(['poor-sleep'])
    expect(assessment.firedRules[0]?.explanation).toBe(
      'At the check-in they reported sleeping poorly the night before.',
    )
    // It fired, so the headline is the "worth noting" one rather than "a normal
    // day" — the same as any other rule that fires without flagging.
    expect(assessment.summary).toBe(
      'Broadly normal, with one or two things worth noting.',
    )
  })

  it('flags exactly these answer combinations with nothing wrong on camera', () => {
    // KV-10, decided: answers alone may raise a flag. A person in pain who has
    // not eaten is having a day worth a look whatever the camera saw. This pins
    // *which* days, so that any weight change which adds or removes one is a
    // visible decision rather than an emergent one. It also holds `poor-sleep`
    // to adding no answers-only combination: this list was taken before that
    // rule existed, and it must not have grown. The camera is perfect throughout
    // (`history(14)` is fourteen identical sessions), so this says nothing about
    // days where a vitals rule fires — the next test does.
    const flagged: string[] = []
    for (const sleep of ['well', 'ok', 'poorly'] as const)
      for (const mood of ['good', 'ok', 'low'] as const)
        for (const skippedMeal of [false, true])
          for (const painReported of [false, true]) {
            const a = scoreSession(
              session({ answers: { sleep, mood, skippedMeal, painReported } }),
              history(14),
            )
            // Taken with `not-eaten` before KV-16; `skipped-meal` weighs the
            // same, so the list is the same days under its new name.
            const ate = skippedMeal ? 'skipped-meal' : 'ate'
            const pain = painReported ? ' pain' : ''
            if (a.flag === 'elevated') flagged.push(`${sleep} ${mood} ${ate}${pain}`)
          }

    expect(flagged.sort()).toEqual(
      [
        'ok low skipped-meal pain',
        'poorly good skipped-meal pain',
        'poorly low ate pain',
        'poorly low skipped-meal pain',
        'poorly ok skipped-meal pain',
        'well low skipped-meal pain',
      ].sort(),
    )
  })

  it('lets poor sleep tip only a day already within 0.05 of the threshold', () => {
    // `poor-sleep` weighs 0.05 and the scorer sums every fired rule, camera ones
    // included, so on a day whose other rules land in [0.55, 0.6) a bad night
    // is what makes it `elevated` (KV-91). That is intended — a real HRV drop
    // plus a bad night is a better amber than the drop alone — and this pins
    // both halves: the band exists, and nothing below it moves. Swept over HRV
    // because `hrv-drop` scales smoothly through the whole range.
    const threshold = ELEVATED_SEVERITY_THRESHOLD
    const sum = (a: Assessment): number => a.firedRules.reduce((t, r) => t + r.severity, 0)
    const tipped: number[] = []
    for (let hrv = 15; hrv <= 26; hrv += 0.05) {
      const slept = scoreSession(session({ vitals: { hrvRmssdMs: hrv } }), history(5))
      const poorly = scoreSession(
        session({ vitals: { hrvRmssdMs: hrv }, answers: { sleep: 'poorly' } }),
        history(5),
      )
      if (slept.flag === poorly.flag) continue
      tipped.push(sum(slept))
      expect(slept.flag).toBe('normal')
      expect(poorly.flag).toBe('elevated')
    }

    expect(tipped.length).toBeGreaterThan(0)
    for (const rest of tipped) {
      expect(rest, `tipped a day whose other rules summed to ${rest.toFixed(4)}`)
        .toBeGreaterThanOrEqual(threshold - 0.05 - 1e-9)
    }
  })

  it('never says when relative to now, because the card it renders on is dated', () => {
    // KV-93: explanations are frozen into the record, and "Pulse was 95 bpm
    // today" under a header reading "Sat, Sep 12" is wrong a week later. The
    // card's date says when; the answer rules anchor to "the check-in" instead.
    // Four sessions: the pain and sleep rules suppress each other, and a z-rule
    // only says "they usually vary by" against a baseline that does vary —
    // `history(5)` does not, so its spread is floored and that clause never shows.
    const vitals = { hrvRmssdMs: 15, pulseRateBpm: 90, breathingRateBrpm: 24 }
    const varied = [72, 78, 69, 81, 75].map((pulse, i) =>
      session({
        id: `v-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: pulse },
      }),
    )
    const fired = [
      scoreSession(
        session({
          vitals,
          answers: { sleep: 'poorly', painReported: true, skippedMeal: true, mood: 'low' },
        }),
        history(5),
      ),
      scoreSession(session({ answers: { sleep: 'poorly' } }), history(5)),
      scoreSession(session({ answers: { painReported: true } }), history(5)),
      // A record from before KV-16, which the old question's rule still reads.
      scoreSession(session({ answers: { eatenToday: false, skippedMeal: undefined } }), history(5)),
      scoreSession(session({ vitals: { pulseRateBpm: 95 } }), varied),
      // The low side (KV-9), against the same flat history.
      scoreSession(session({ vitals: { pulseRateBpm: 40, breathingRateBrpm: 6 } }), history(5)),
    ].flatMap((a) => a.firedRules)

    // The spread clause is actually in there, not just a rule that can carry it.
    expect(fired.some((r) => /usually vary by/.test(r.explanation))).toBe(true)

    // Every rule is covered, so a new one cannot slip past this.
    expect(new Set(fired.map((r) => r.id))).toEqual(new Set(ALL_RULES.map((r) => r.id)))
    for (const rule of fired) {
      for (const text of [rule.title, rule.explanation]) {
        expect(text, rule.id).not.toMatch(RELATIVE_TIME)
      }
    }
  })

  it('writes every summary without saying when relative to now', () => {
    // KV-93: the summary is the first line on the card and is frozen into the
    // record the same way, so "Today looks different" under "Sat, Sep 12" was the
    // louder half of the problem. One session per summary the scorer can write.
    const empty = {
      pulseRateBpm: null,
      breathingRateBrpm: null,
      hrvRmssdMs: null,
      hrvSdnnMs: null,
    }
    const summaries = [
      scoreSession(session(), history(5)),
      scoreSession(session({ answers: { mood: 'low' } }), history(5)),
      scoreSession(
        session({ answers: { skippedMeal: true, painReported: true, mood: 'low' } }),
        history(5),
      ),
      scoreSession(session(), history(MIN_BASELINE_SESSIONS - 1)),
      scoreSession(session(), [...refusedCaptures(1), ...history(1)]),
      scoreSession(session(), [...refusedCaptures(4), ...history(2)]),
      scoreSession(session({ vitals: empty }), history(5)),
      scoreSession(session({ vitals: { durationSec: MIN_CAPTURE_SECONDS - 1 } }), history(5)),
      scoreSession(session({ vitals: { confidence: null } }), history(5)),
      scoreSession(session({ vitals: { confidence: 0.2 } }), history(5)),
    ].map((a) => a.summary)

    expect(new Set(summaries).size).toBe(summaries.length)
    for (const summary of summaries) expect(summary).not.toMatch(RELATIVE_TIME)
    // The headline quotes the top rule's title, so the title has to read as a
    // clause: "skipped a meal" keeps the question's scope (KV-16).
    expect(summaries[2]).toBe('Different from their usual — skipped a meal.')
  })

  it('orders fired rules by severity, strongest first', () => {
    const assessment = scoreSession(
      session({
        vitals: { hrvRmssdMs: 15 },
        answers: { mood: 'low', skippedMeal: true },
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
      expect(scoreSession(s, history(5)).summary).toContain('this check-in is not being compared')
    }
  })

  it('says why a still-learning count is lower than the check-ins done (KV-100)', () => {
    const refused = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        session({ id: `r-${i}`, capturedAt: `2026-09-0${i + 1}T08:00:00.000Z`, vitals: { confidence: 0.2 } }),
      )
    expect(scoreSession(session(), [...history(2), ...refused(4)]).summary).toBe(
      'Not yet enough history to compare this check-in (2 of 3 usable check-ins before it). ' +
        '4 check-ins before this one could not be used, so they are not counted.',
    )
    expect(scoreSession(session(), [...history(1), ...refused(1)]).summary).toBe(
      'Not yet enough history to compare this check-in (1 of 3 usable check-ins before it). ' +
        '1 check-in before this one could not be used, so it is not counted.',
    )
    const scored = scoreSession(session(), [...history(5), ...refused(2)])
    expect(scored.baselineRefusedSessions).toBe(2)
    // No clause where nothing was refused.
    expect(scoreSession(session(), history(2)).summary).not.toMatch(/could not be used/)
  })

  it('says nothing about refusals on a card that did not record them, rather than "none"', () => {
    // Scored before KV-100: the refusal count is unknown, not zero.
    const old = {
      ...session(),
      assessment: {
        flag: 'insufficient-signal' as const,
        firedRules: [],
        summary: 'Still learning their normal — 1 of 3 check-ins needed before daily comparisons start.',
        baselineSessions: 1,
        baselineSeededSessions: 0,
      },
    }
    expect(present(old, history(1))?.summary).toBe(
      'Not yet enough history to compare this check-in (1 of 3 usable check-ins before it).',
    )
    // Nor does its drift line, when refusals sit behind it and nothing else
    // changed: the unknown count is unknown on both sides of the comparison
    // (KV-100 review, finding 1). As stored between KV-138 and KV-100.
    const between = {
      ...session(),
      assessment: {
        ...old.assessment,
        withheld: 'still-learning' as const,
        summary: 'Still learning their normal — 1 of 3 check-ins needed before daily comparisons start.',
      },
    }
    const shown = present(between, [...refusedCaptures(1), ...history(1)])
    expect(shown?.summary).toBe(
      'Not yet enough history to compare this check-in (1 of 3 usable check-ins before it).',
    )
    expect(shown?.drift).toBeNull()

    // A count that did change still drifts, and quotes today's sentence whole:
    // before KV-72 the refused capture counted, so this card stored 1 of 3.
    const beforeKv72 = present(old, [...refusedCaptures(1)])
    expect(beforeKv72?.drift).toBe(
      'Scored again now, it would say instead: “Not yet enough history to compare this check-in ' +
        '(0 of 3 usable check-ins before it). 1 check-in before this one could not be used, so it is ' +
        'not counted.”',
    )
  })

  it('does not compare against a usual it does not have yet', () => {
    // The card used to withhold the comparison and make it in consecutive
    // sentences: "1 of 3 check-ins needed before daily comparisons start",
    // then "Breathing was 16 breaths/min, above their usual 15" (KV-71).
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 16 } }), history(1))

    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.summary).toMatch(/^Not yet enough history to compare this check-in/)
    expect(assessment.firedRules).toEqual([])
  })

  it('runs the answer rules while the baseline is building, and says so truthfully', () => {
    // The sentence has always claimed the answer rules are what still ran.
    // Until KV-71 every rule ran; now the claim is true.
    const assessment = scoreSession(
      session({ vitals: { breathingRateBrpm: 16 }, answers: { skippedMeal: true } }),
      history(1),
    )

    expect(assessment.firedRules.map((r) => r.id)).toEqual(['skipped-meal'])
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
    // The severity is not cosmetic: 0.333 alongside skipped-meal's 0.3 clears
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
      session({ vitals: { breathingRateBrpm: 16 }, answers: { skippedMeal: true } }),
      past,
    )

    expect(assessment.flag).not.toBe('elevated')
    expect(ids(assessment)).toEqual(['skipped-meal'])
    // Not `normal` either, since KV-87: breathing was measured and never
    // compared, so a green verdict would claim a check that did not happen.
    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.uncomparedMetrics).toEqual([
      { metric: 'breathing', readings: 1, needed: MIN_BASELINE_SESSIONS, mean: 15 },
    ])
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

  it('does not quote a reading it refused to show as their usual', () => {
    // KV-72, the pair from the ticket. One card says "the camera reading was
    // not clear enough to use today" and shows no verdict; the next was
    // measuring against that very reading and calling it their normal, with
    // nothing on either card connecting them.
    // Numbers chosen so the rule fires either way and only the quoted "usual"
    // differs: admitting the refused 19 moves the mean to 16 and gives the sd
    // something to be, so the broken behaviour is a *wrong number* rather than
    // a rule that goes quiet. An outlier large enough to be obvious inflates
    // the sd instead and suppresses the rule, which makes the regression
    // assertion untestable (KV-72 review).
    const refused = session({
      id: 'refused',
      capturedAt: '2026-09-04T09:00:00.000Z',
      vitals: { breathingRateBrpm: 19, confidence: 0.3 },
    })
    const past = [...history(3, { breathingRateBrpm: 15 }), refused]
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 25 } }), past)
    const rule = assessment.firedRules.find((r) => r.id === 'breathing-elevated')

    // Their usual is the three captures the app was willing to use, not four.
    expect(rule?.explanation).toContain('usual 15 breaths/min')
    expect(rule?.explanation).not.toContain('usual 16')
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
      session({ answers: { skippedMeal: true } }),
      seededHistory(2),
    )
    expect(assessment.firedRules.map((r) => r.id)).toEqual(['skipped-meal'])
    expect(seededBaselineDisclosure(assessment)).toBeNull()
  })

  it('derives the disclosure set from the flag the rules already carry', () => {
    // Two hand-kept encodings of "quotes their usual" — `usesBaseline` gating
    // suppression and `BASELINE_RULE_IDS` gating disclosure — agreed by hand
    // with nothing checking they still would. A fourth comparison rule added
    // with the flag and forgotten from the list would suppress correctly, so
    // every thin-baseline test would pass, and then quote an invented usual on
    // a mature seeded baseline with no disclosure (KV-71).
    const flagged = ALL_RULES.filter((rule) => rule.compares !== undefined).map((r) => r.id)

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
describe('seededDisclosureFor', () => {
  it('still discloses on a real capture compared against the seeded fortnight', () => {
    // The card the sentence exists for: real readings, invented usual.
    const real = session()
    real.assessment = scoreSession(real, seededHistory(12))
    expect(seededDisclosureFor(real)).not.toBeNull()
    expect(seededDisclosureFor(real)).toBe(seededBaselineDisclosure(real.assessment))
  })

  it('shows nothing on a seeded card, whose own label already says so', () => {
    // KV-103 scores the demo on display; without this, nine demo cards would
    // each repeat the sentence and bury the one real card it is for.
    const demo = session({ seeded: true })
    demo.assessment = scoreSession(demo, seededHistory(12))
    expect(seededBaselineDisclosure(demo.assessment)).not.toBeNull()
    expect(seededDisclosureFor(demo)).toBeNull()
  })

  it('shows nothing on a card with no verdict', () => {
    expect(seededDisclosureFor(session())).toBeNull()
  })
})

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

  it('withholds on a shape the store could hand it, rather than vouching for it', () => {
    // KV-72 review. `store.ts` casts parsed JSON to `SessionRecord` without
    // validating it, and this predicate now reads every record in the history
    // file rather than one freshly measured capture. `undefined < 20` and
    // `undefined < 0.5` are both false, and NaN slips `typeof === 'number'`
    // as well — so each of these walked past the gate as a full-length,
    // fully vouched-for capture. A NaN confidence reading as vouched-for is
    // the exact failure KV-12 closed for null, on a different input.
    const shapes: [string, Record<string, unknown>, string][] = [
      ['durationSec missing', { durationSec: undefined }, 'too-short'],
      ['durationSec NaN', { durationSec: NaN }, 'too-short'],
      ['confidence NaN', { confidence: NaN }, 'unrated'],
      ['confidence missing', { confidence: undefined }, 'unrated'],
    ]
    for (const [name, override, expected] of shapes) {
      const vitals = { ...session().vitals, ...override } as ReturnType<
        typeof session
      >['vitals']
      expect(unusableReason(vitals), name).toBe(expected)
    }
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

describe('a metric measured but never compared (KV-87)', () => {
  /** Three usable sessions; pulse in only two of them, as on the real hardware. */
  const thinPulse = (): ReturnType<typeof history> => [
    ...history(2, { pulseRateBpm: 82 }),
    session({ id: 'h-2', capturedAt: '2026-09-03T09:00:00.000Z', vitals: { pulseRateBpm: null } }),
  ]

  it('withholds "normal" when pulse was measured and had no usual — the check-in on the ticket', () => {
    // 101.5 against a usual of 82 on two readings: pulse-elevated correctly
    // held back (KV-71), and the card used to read "A normal day for them".
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 101.5 } }), thinPulse())

    expect(ids(assessment)).not.toContain('pulse-elevated')
    expect(assessment.flag).toBe('insufficient-signal')
    // Not the card's label again: the summary says why the verdict is withheld.
    expect(assessment.summary).toBe('Only partly compared with their usual — see the note below.')
    expect(assessment.uncomparedMetrics).toEqual([
      { metric: 'pulse', readings: 2, needed: MIN_BASELINE_SESSIONS, mean: 82 },
    ])
    // The 82 is quoted as what two readings showed, never as "their usual".
    expect(uncomparedDisclosure(assessment)).toBe(
      'Pulse was measured at this check-in but not compared with their usual: it had 2 of ' +
        `the ${MIN_BASELINE_SESSIONS} readings needed to know it (those 2 averaged 82 bpm). ` +
        'So this check-in is not being called normal.',
    )
    expect(uncomparedDisclosure(assessment)).not.toMatch(/their usual \d/)
  })

  it('lets an elevated verdict stand, and still names the gap', () => {
    // Withholding it would hide a real signal to cover a missing one.
    const assessment = scoreSession(
      session({
        vitals: { pulseRateBpm: 101.5 },
        answers: { sleep: 'poorly', painReported: true, skippedMeal: true },
      }),
      thinPulse(),
    )

    expect(assessment.flag).toBe('elevated')
    expect(uncomparedDisclosure(assessment)).toBe(
      'Pulse was measured at this check-in but not compared with their usual: it had 2 of ' +
        `the ${MIN_BASELINE_SESSIONS} readings needed to know it (those 2 averaged 82 bpm).`,
    )
  })

  it('does not count a metric that produced nothing as a gap', () => {
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: null } }), thinPulse())

    expect(assessment.flag).toBe('normal')
    expect(assessment.uncomparedMetrics).toEqual([])
    expect(uncomparedDisclosure(assessment)).toBeNull()
  })

  it('is normal, with nothing to disclose, when every measured metric was compared', () => {
    const assessment = scoreSession(session(), history(5))

    expect(assessment.flag).toBe('normal')
    expect(assessment.uncomparedMetrics).toEqual([])
    expect(uncomparedDisclosure(assessment)).toBeNull()
  })

  it('names every metric that went uncompared, including one with no readings at all', () => {
    const past = history(3, { hrvRmssdMs: null }).map((s, i) =>
      i === 0 ? { ...s, vitals: { ...s.vitals, pulseRateBpm: null } } : s,
    )
    const assessment = scoreSession(session(), past)

    expect(assessment.uncomparedMetrics).toEqual([
      { metric: 'pulse', readings: 2, needed: MIN_BASELINE_SESSIONS, mean: 72 },
      { metric: 'hrv', readings: 0, needed: MIN_BASELINE_SESSIONS },
    ])
    // Card order, whatever order the rules are listed in; no number for HRV,
    // which had no readings to show.
    expect(uncomparedDisclosure(assessment)).toBe(
      'Pulse and HRV were measured at this check-in but not compared with their usual: pulse ' +
        `had 2 of the ${MIN_BASELINE_SESSIONS} readings needed to know it (those 2 averaged ` +
        `72 bpm) and HRV had 0 of ${MIN_BASELINE_SESSIONS}. So this check-in is not being ` +
        'called normal.',
    )
  })

  it('quotes a single reading as that one reading, not as an average', () => {
    const past = [
      session({ id: 'h-0', capturedAt: '2026-09-01T09:00:00.000Z' }),
      ...history(2, { breathingRateBrpm: null }).map((s, i) => ({ ...s, id: `n-${i}` })),
    ]
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 16 } }), past)

    expect(uncomparedDisclosure(assessment)).toMatch(
      /^Breathing rate was measured .*: it had 1 of the 3 readings needed to know it \(that one was 15 breaths\/min\)\./,
    )
  })

  it('writes nothing for a capture it could not use, or a baseline still learning', () => {
    // The summary already says nothing was compared; a second sentence would
    // single out one metric from a comparison that never started.
    const unusable = scoreSession(session({ vitals: { confidence: null } }), history(5))
    const learning = scoreSession(session(), history(MIN_BASELINE_SESSIONS - 1))

    for (const a of [unusable, learning]) {
      expect(a.uncomparedMetrics).toBeUndefined()
      expect(uncomparedDisclosure(a)).toBeNull()
    }
  })

  it('reads a verdict scored before KV-87 as unknown, not as "none"', () => {
    const { uncomparedMetrics: _absent, ...older } = scoreSession(session(), history(5))

    expect(uncomparedDisclosure(older)).toBe(
      'Whether every reading at this check-in was compared with their usual was not recorded ' +
        'when it was scored.',
    )
    // A withheld verdict claimed no comparison, so there is nothing unknown to admit.
    expect(uncomparedDisclosure({ ...older, flag: 'insufficient-signal' })).toBeNull()
  })

  it('says nothing relative to now', () => {
    const past = history(3, { hrvRmssdMs: null })
    for (const a of [
      scoreSession(session({ vitals: { pulseRateBpm: 101.5 } }), thinPulse()),
      scoreSession(session({ answers: { sleep: 'poorly', painReported: true } }), past),
    ]) {
      expect(a.summary).not.toMatch(RELATIVE_TIME)
      expect(uncomparedDisclosure(a) ?? '').not.toMatch(RELATIVE_TIME)
    }
  })

  it('keeps the seeded disclosure on a withheld card, even with no rule fired', () => {
    // KV-87 review: "only partly compared" claims the other metrics were
    // compared, so a seeded usual behind them must still be disclosed. Keyed
    // on the flag, the note vanished when a pulse reading was *added*.
    const past = [
      ...seededHistory(2),
      session({ id: 'real', capturedAt: '2026-09-03T09:00:00.000Z', vitals: { pulseRateBpm: null } }),
    ]
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 90 } }), past)

    expect(assessment.flag).toBe('insufficient-signal')
    expect(assessment.firedRules).toEqual([])
    expect(uncomparedDisclosure(assessment)).toMatch(/^Pulse was measured/)
    expect(seededBaselineDisclosure(assessment)).toBe(
      'Their usual here is partly seeded demo data — 2 of the 3 check-ins behind this ' +
        'comparison were invented, not measured.',
    )
  })

  it('leaves the seeded demo alone: every seeded day carries every metric', () => {
    for (const day of withSeededVerdicts(seedDemoHistory())) {
      expect(day.assessment?.flag, day.id).not.toBe('elevated')
      if (day.assessment?.uncomparedMetrics !== undefined) {
        expect(day.assessment.uncomparedMetrics, day.id).toEqual([])
      }
    }
  })
})

describe('readings below their usual (KV-9)', () => {
  it('fires pulse-low on a pulse well below their usual, in numbers', () => {
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 40 } }), history(5))

    expect(ids(assessment)).toEqual(['pulse-low'])
    const rule = assessment.firedRules[0]
    expect(rule?.title).toBe('Pulse below usual')
    expect(rule?.explanation).toMatch(/^Pulse was 40 bpm, below their usual 72 bpm\./)
  })

  it('fires breathing-low on breathing well below their usual', () => {
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 6 } }), history(5))

    expect(ids(assessment)).toEqual(['breathing-low'])
    expect(assessment.firedRules[0]?.explanation).toMatch(
      /^Breathing was 6 breaths\/min, below their usual 15 breaths\/min\./,
    )
  })

  it('says how far they usually vary on the low side too, with the singular unit at 1', () => {
    // KV-9 review: every other low-side text runs against a flat history, which
    // takes the floored branch and never shows the spread clause. A spread of
    // exactly 1 is the case `singularUnit` exists for.
    const past = [14, 16, 14, 16, 15].map((breathing, i) =>
      session({
        id: `b-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { breathingRateBrpm: breathing },
      }),
    )
    const assessment = scoreSession(session({ vitals: { breathingRateBrpm: 12 } }), past)

    expect(ids(assessment)).toEqual(['breathing-low'])
    expect(assessment.firedRules[0]?.explanation).toBe(
      'Breathing was 12 breaths/min, below their usual 15 breaths/min. ' +
        'They usually vary by about 1 breath/min either way.',
    )
  })

  it('weighs a fall exactly as it weighs the same rise', () => {
    // Mirrored, not re-tuned: same threshold, same curve, same peak (#22 calibrates).
    const varied = [72, 78, 69, 81, 75].map((pulse, i) =>
      session({
        id: `v-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: pulse },
      }),
    )
    const mean = 75
    // The spread is about 4.7, so these are z of about 2.1, 3 and 4.2.
    for (const by of [10, 14, 20]) {
      const up = scoreSession(session({ vitals: { pulseRateBpm: mean + by } }), varied)
      const down = scoreSession(session({ vitals: { pulseRateBpm: mean - by } }), varied)
      expect(ids(up), `+${by}`).toEqual(['pulse-elevated'])
      expect(ids(down), `-${by}`).toEqual(['pulse-low'])
      expect(down.firedRules[0]?.severity).toBeCloseTo(up.firedRules[0]?.severity ?? NaN)
    }
  })

  it('does not fire on a fall inside the same threshold the rise must clear', () => {
    // The hardware reading on #9: 80 against a usual of about 97, spread about
    // 13 — z of about -1.25. Below Z_FIRES_AT, as +1.25 would be on the high
    // side, so it still produces nothing. That is the mirrored threshold as
    // decided, not an oversight; moving it is #22's calibration.
    const past = [101, 109, 108, 80, 85.5].map((pulse, i) =>
      session({
        id: `hw-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { pulseRateBpm: pulse },
      }),
    )
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 80.1 } }), past)

    expect(ids(assessment)).not.toContain('pulse-low')
    expect(assessment.flag).toBe('normal')
  })

  it('never fires both directions on one reading', () => {
    for (const pulse of [30, 60, 72, 84, 140]) {
      const fired = ids(scoreSession(session({ vitals: { pulseRateBpm: pulse } }), history(5)))
      expect(fired.includes('pulse-low') && fired.includes('pulse-elevated'), `${pulse}`).toBe(false)
    }
  })

  it('does not quote "below their usual" off a thin history, and names the gap once', () => {
    // The same per-metric gate as the high side (KV-71). Two rules now compare
    // pulse, and the uncompared note must still name it once, not twice (KV-87).
    const past = [
      ...history(2, { pulseRateBpm: 82 }),
      session({ id: 'h-2', capturedAt: '2026-09-03T09:00:00.000Z', vitals: { pulseRateBpm: null } }),
    ]
    const assessment = scoreSession(session({ vitals: { pulseRateBpm: 50 } }), past)

    expect(ids(assessment)).not.toContain('pulse-low')
    expect(assessment.uncomparedMetrics).toEqual([
      { metric: 'pulse', readings: 2, needed: MIN_BASELINE_SESSIONS, mean: 82 },
    ])
  })

  it('discloses a seeded usual behind a fall, as it does behind a rise', () => {
    expect(BASELINE_RULE_IDS.has('pulse-low')).toBe(true)
    expect(BASELINE_RULE_IDS.has('breathing-low')).toBe(true)
  })
})

describe('what the camera alone can flag, with every answer benign', () => {
  // The README and ARCHITECTURE describe this balance in prose, and prose went
  // stale once: a docs pass wrote "the camera cannot flag a day alone unless
  // HRV falls by half", which is true of one rule and false of two (review of
  // #126). The answers side is pinned (KV-10); this pins the camera side, so
  // a weight or threshold change that moves it fails here, not in a doc.
  //
  // A history with a measured spread on both rates: pulse mean 75, sd ≈ 4.74;
  // breathing mean 15, sd 1. HRV is the helper's flat 34.
  const past = [
    [72, 14],
    [78, 16],
    [69, 14],
    [81, 16],
    [75, 15],
  ].map(([pulse, breathing], i) =>
    session({
      id: `c-${i}`,
      capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
      vitals: { pulseRateBpm: pulse, breathingRateBrpm: breathing },
    }),
  )
  const sd = Math.sqrt(22.5)
  const pulseAt = (z: number): number => 75 + z * sd
  const breathingAt = (z: number): number => 15 + z

  it.each([
    ['pulse and breathing each 3 sd high', { pulseRateBpm: pulseAt(3), breathingRateBrpm: breathingAt(3) }],
    ['pulse and breathing each 3 sd low', { pulseRateBpm: pulseAt(-3), breathingRateBrpm: breathingAt(-3) }],
    ['HRV down about a quarter, breathing 3 sd high', { hrvRmssdMs: 25, breathingRateBrpm: breathingAt(3) }],
    ['HRV down by half, on its own', { hrvRmssdMs: 17 }],
  ])('flags %s', (_what, vitals) => {
    expect(scoreSession(session({ vitals }), past).flag).toBe('elevated')
  })

  it.each([
    ['pulse 5 sd high, on its own', { pulseRateBpm: pulseAt(5) }],
    ['breathing 5 sd low, on its own', { breathingRateBrpm: breathingAt(-5) }],
    ['pulse and breathing each just past 2 sd', { pulseRateBpm: pulseAt(2.05), breathingRateBrpm: breathingAt(2.05) }],
  ])('does not flag %s', (_what, vitals) => {
    expect(scoreSession(session({ vitals }), past).flag).toBe('normal')
  })

  it('gives a rate rule half its peak the moment it fires', () => {
    // The floor, not the cap, is what decides whether two camera rules clear
    // the threshold: 0.225 for pulse and 0.20 for breathing at 2 sd.
    const fired = scoreSession(
      session({ vitals: { pulseRateBpm: pulseAt(2.0001), breathingRateBrpm: breathingAt(2.0001) } }),
      past,
    ).firedRules
    expect(fired.find((r) => r.id === 'pulse-elevated')?.severity).toBeCloseTo(0.225, 3)
    expect(fired.find((r) => r.id === 'breathing-elevated')?.severity).toBeCloseTo(0.2, 3)
  })
})

describe('present: what an old card says once the scorer has changed (KV-138)', () => {
  /** A stored assessment as an older scorer wrote it. */
  const stored = (over: Partial<Assessment>): Assessment => ({
    flag: 'normal',
    firedRules: [],
    summary: 'Today looks like a normal day for them.',
    baselineSessions: 5,
    baselineSeededSessions: 0,
    ...over,
  })
  const at = (id: string, day: number, over: Parameters<typeof session>[0] = {}) =>
    session({ id, capturedAt: new Date(Date.UTC(2026, 8, day, 9)).toISOString(), ...over })

  it('composes a card scored now to exactly what it stored, with no drift', () => {
    const past = history(5)
    const cases = [
      session(),
      session({ answers: { mood: 'low' } }),
      session({ vitals: { hrvRmssdMs: 20 }, answers: { sleep: 'poorly', painReported: true } }),
      session({ vitals: { confidence: 0.2 } }),
      session({ vitals: { pulseRateBpm: 40 } }),
    ]
    for (const s of cases) {
      const scored = { ...s, assessment: scoreSession(s, past) }
      const shown = present(scored, past)
      expect(shown?.summary).toBe(scored.assessment.summary)
      expect(shown?.firedRules).toEqual(scored.assessment.firedRules)
      expect(shown?.drift).toBeNull()
    }
    // Still learning, with and without refusals behind it (KV-100 review): a
    // card that lost its stored count would lose its clause and grow a drift line.
    for (const prior of [history(1), [...refusedCaptures(2), ...history(1)]]) {
      const learning = { ...session(), assessment: scoreSession(session(), prior) }
      const shown = present(learning, prior)
      expect(shown?.summary).toBe(learning.assessment.summary)
      expect(shown?.drift).toBeNull()
    }
  })

  it('drops "today" from a summary scored before KV-93, keeping the verdict', () => {
    const old = { ...session(), assessment: stored({}) }
    const shown = present(old, history(5))
    expect(shown?.summary).toBe('A normal day for them.')
    expect(shown?.drift).toBeNull()
    expect(old.assessment.flag).toBe('normal')
  })

  it('writes an answer rule in its current words, and keeps its severity', () => {
    const old = {
      ...session({ answers: { eatenToday: false, skippedMeal: undefined } }),
      assessment: stored({
        firedRules: [
          { id: 'not-eaten', title: 'Has not eaten today', explanation: 'They have not eaten today.', severity: 0.3 },
        ],
        summary: 'Today looks broadly normal, with one or two things worth noting.',
      }),
    }
    const [rule] = present(old, history(5))?.firedRules ?? []
    expect(rule?.title).toBe('Had not eaten yet')
    expect(rule?.explanation).not.toMatch(RELATIVE_TIME)
    expect(rule?.severity).toBe(0.3)
  })

  it('rewords a rule today’s engine no longer fires, and says so without "today"', () => {
    // Pain with poor sleep: `pain-reported` now defers to the pair, so it
    // cannot be evaluated again for its words (KV-138 review, finding 3).
    const old = {
      ...session({ answers: { painReported: true, sleep: 'poorly' } }),
      assessment: stored({
        firedRules: [
          { id: 'pain-reported', title: 'Pain reported', explanation: 'They reported being in pain today.', severity: 0.25 },
        ],
      }),
    }
    const shown = present(old, history(5))
    expect(shown?.firedRules[0]?.explanation).toBe('At the check-in they reported being in pain.')
    expect(shown?.drift).toBe(
      'Scored again now, it would also note poor sleep and pain reported together, and no longer ' +
        'note pain reported.',
    )
  })

  it('rewords a rule the engine no longer has by the text it carries, not by guessing its kind', () => {
    const old = {
      ...session(),
      assessment: stored({
        firedRules: [
          { id: 'retired-rule', title: 'Has not eaten today', explanation: 'They described their mood as low today.', severity: 0.1 },
        ],
      }),
    }
    const [rule] = present(old, history(5))?.firedRules ?? []
    expect(rule?.title).toBe('Had not eaten yet')
    expect(rule?.explanation).toBe('At the check-in they described their mood as low.')
  })

  it('says nothing relative to now anywhere on a pre-KV-93 card, drift line included', () => {
    // Every stored form KV-93 changed, on cards that drift, withhold and
    // compare, so the sweep covers summary, rules and the new sentence alike.
    const pastPulse = [72, 78, 69, 81, 75].map((pulse, i) => at(`p-${i}`, i + 1, { vitals: { pulseRateBpm: pulse } }))
    const answers = { painReported: true, sleep: 'poorly', mood: 'low', eatenToday: false, skippedMeal: undefined } as const
    const olds = [
      stored({
        firedRules: [
          { id: 'pain-reported', title: 'Pain reported', explanation: 'They reported being in pain today.', severity: 0.25 },
          { id: 'poor-sleep', title: 'Slept poorly', explanation: 'They reported sleeping poorly last night.', severity: 0.2 },
          { id: 'low-mood', title: 'Low mood reported', explanation: 'They described their mood as low today.', severity: 0.2 },
          { id: 'not-eaten', title: 'Has not eaten today', explanation: 'x', severity: 0.1 },
          {
            id: 'poor-sleep-with-pain',
            title: 'Poor sleep and pain reported together',
            explanation: 'They reported sleeping poorly and being in pain today.',
            severity: 0.3,
          },
          { id: 'hrv-drop', title: 'Heart-rate variability below usual', explanation: 'HRV was 20 ms today, about 41% below their usual 34 ms.', severity: 0.49 },
        ],
      }),
      stored({ flag: 'elevated', summary: 'Today looks different from usual.' }),
      stored({ flag: 'insufficient-signal', summary: 'The camera reading was not clear enough to use today.' }),
      stored({ flag: 'insufficient-signal', summary: 'The camera ran but no reading came out of it, so today is not being compared.' }),
    ]
    // A thin past with refusals too, so the still-learning clause is swept (KV-100 review).
    const pasts = [pastPulse, [...refusedCaptures(2), ...pastPulse.slice(0, 1)]]
    for (const assessment of olds) {
      for (const [vitals, past] of [{ pulseRateBpm: 40 }, { confidence: 0.2 }, {}].flatMap(
        (v) => pasts.map((p) => [v, p] as const),
      )) {
        const shown = present({ ...at('now', 10, { vitals, answers }), assessment }, past)
        for (const line of [shown?.summary, shown?.drift, shown?.uncomparedNote]) {
          expect(line ?? '').not.toMatch(RELATIVE_TIME)
        }
        for (const rule of shown?.firedRules ?? []) {
          expect(rule.title).not.toMatch(RELATIVE_TIME)
          expect(rule.explanation).not.toMatch(RELATIVE_TIME)
        }
      }
    }
  })

  it('keeps a comparison rule’s numbers, dropping only the "today" KV-93 removed', () => {
    const old = {
      ...session({ vitals: { hrvRmssdMs: 20 } }),
      assessment: stored({
        flag: 'normal',
        firedRules: [
          {
            id: 'hrv-drop',
            title: 'Heart-rate variability below usual',
            explanation: 'HRV was 20 ms today, about 41% below their usual 34 ms.',
            severity: 0.49,
          },
        ],
      }),
    }
    expect(present(old, history(5))?.firedRules[0]?.explanation).toBe(
      'HRV was 20 ms, about 41% below their usual 34 ms.',
    )
  })

  it('composes a withheld card’s reason from what the record says, not from today’s predicates', () => {
    // Stored "still learning" on vitals today's predicate would call unrated:
    // the card keeps the reason it was given, and the drift line says the
    // other one (KV-138 review, finding 1).
    const learning = stored({
      flag: 'insufficient-signal',
      summary: 'Still learning their normal — 1 of 3 check-ins needed before daily comparisons start.',
      baselineSessions: 1,
    })
    const shown = present({ ...session({ vitals: { confidence: null } }), assessment: learning }, history(1))
    // Its reason, in today's words for it (KV-100).
    expect(shown?.summary).toBe(
      'Not yet enough history to compare this check-in (1 of 3 usable check-ins before it).',
    )
    expect(shown?.drift).toBe(
      // A different label too, since KV-17: "Too early to compare" would read
      // "Not enough to say".
      'Scored again now, it would read “Not enough to say”: the camera did not say how reliable ' +
        'this reading was, so this check-in is not being compared.',
    )

    // A stored reason wins over the summary, whatever the summary says.
    const marked = stored({ flag: 'insufficient-signal', withheld: 'too-short', summary: 'x' })
    expect(present({ ...session({ vitals: { durationSec: 5 } }), assessment: marked }, history(5))?.summary).toBe(
      'The camera did not run for long enough to use, so this check-in is not being compared.',
    )
  })

  it('reads a pre-KV-93 unusable summary as the reason it names, in today’s words', () => {
    const old = {
      ...session({ vitals: { confidence: 0.2 } }),
      assessment: stored({
        flag: 'insufficient-signal',
        summary: 'The camera reading was not clear enough to use, so today is not being compared.',
      }),
    }
    const shown = present(old, history(5))
    expect(shown?.summary).toBe(
      'The camera reading was not clear enough to use, so this check-in is not being compared.',
    )
    expect(shown?.drift).toBeNull()
  })

  it('keeps the scaffold’s one unusable sentence, less its "today", rather than guess a reason', () => {
    // Before KV-12 one sentence covered three failures, so no reason can be
    // read back from it.
    const old = {
      ...session({ vitals: { confidence: 0.2 } }),
      assessment: stored({
        flag: 'insufficient-signal',
        summary: 'The camera reading was not clear enough to use today.',
      }),
    }
    const shown = present(old, history(5))
    expect(shown?.summary).toBe('The camera reading was not clear enough to use.')
    // Today's more specific reason is not a different one.
    expect(shown?.drift).toBeNull()
    // A capture today's scorer would use is.
    const usable = present({ ...old, vitals: session().vitals }, history(1))
    expect(usable?.drift).toMatch(
      /^Scored again now, it would read “Too early to compare”, because there was not yet enough history/,
    )
  })

  it('stores why a verdict was withheld, so it is never re-decided', () => {
    expect(scoreSession(session({ vitals: { confidence: 0.2 } }), history(5)).withheld).toBe('low-confidence')
    expect(scoreSession(session(), history(1)).withheld).toBe('still-learning')
    const thin = [...history(2, { pulseRateBpm: 82 }), at('h-2', 3, { vitals: { pulseRateBpm: null } })]
    expect(scoreSession(session({ vitals: { pulseRateBpm: 101.5 } }), thin).withheld).toBe('uncompared')
    expect(scoreSession(session(), history(5)).withheld).toBeUndefined()
  })

  it('says when today’s scorer would give a different verdict, and why', () => {
    // Stored normal, with nothing fired: a rule since added would now make it amber.
    const past = [72, 78, 69, 81, 75].map((pulse, i) => at(`p-${i}`, i + 1, { vitals: { pulseRateBpm: pulse } }))
    const s = at('now', 10, { vitals: { pulseRateBpm: 40 }, answers: { sleep: 'poorly', painReported: true } })
    const shown = present({ ...s, assessment: stored({}) }, past)
    expect(shown?.drift).toBe(
      // Its top rule by severity; pulse-low at full weight ties with the pair
      // and comes first in rule order.
      'Scored again now, it would read “Looks different” — pulse below usual.',
    )
  })

  it('says when the verdict stands but the rules would differ', () => {
    // A fall that breathing-low now catches, stored as "Looks normal" with
    // nothing fired: still normal (the rule alone is under the threshold),
    // but the card should no longer be silent about it.
    const past = [14, 16, 14, 16, 15].map((b, i) => at(`b-${i}`, i + 1, { vitals: { breathingRateBrpm: b } }))
    const s = at('now', 10, { vitals: { breathingRateBrpm: 5 } })
    const shown = present({ ...s, assessment: stored({}) }, past)
    expect(shown?.drift).toBe(
      'Scored again now, it would also note breathing below usual.',
    )
  })

  it('says when a rule it fired would no longer fire', () => {
    const shown = present(
      {
        ...session(),
        assessment: stored({
          firedRules: [{ id: 'low-mood', title: 'Low mood reported', explanation: 'x', severity: 0.2 }],
        }),
      },
      history(5),
    )
    expect(shown?.drift).toBe(
      'Scored again now, it would no longer note low mood reported.',
    )
  })

  it('gives a withheld drift its reason', () => {
    // Stored normal on a thin history that an older scorer compared anyway.
    const shown = present({ ...session(), assessment: stored({}) }, history(1))
    expect(shown?.drift).toBe(
      'Scored again now, it would read “Too early to compare”, because there was not yet enough ' +
        'history to compare it (1 of 3 usable check-ins before it).',
    )
    // With refusals behind it, still one sentence (KV-100 review, finding 2).
    const refused = present({ ...session(), assessment: stored({}) }, [...refusedCaptures(2), ...history(1)])
    expect(refused?.drift).toBe(
      'Scored again now, it would read “Too early to compare”, because there was not yet enough ' +
        'history to compare it (1 of 3 usable check-ins before it; 2 check-ins before this one could ' +
        'not be used).',
    )
  })

  it('finds a pre-KV-87 card’s gaps by scoring it again, rather than saying "not recorded"', () => {
    const thin = [...history(2, { pulseRateBpm: 82 }), at('h-2', 3, { vitals: { pulseRateBpm: null } })]
    const s = session({ vitals: { pulseRateBpm: 101.5 } })
    const shown = present({ ...s, assessment: stored({}) }, thin)
    expect(shown?.uncomparedNote).toMatch(/^Pulse was measured at this check-in but not compared/)
    expect(shown?.drift).toBe(
      'Scored again now, it would read “Not enough to say”, because pulse could not be compared ' +
        'with their usual (below).',
    )
    const fine = present({ ...session(), assessment: stored({}) }, history(5))
    expect(fine?.uncomparedNote).toBeNull()
  })

  it('points below only when the note below names the same gaps', () => {
    // Stored as compared in full (KV-87's empty list), so no note is shown —
    // and the drift line must not point at one (KV-138 review, finding 2).
    const thin = [...history(2, { pulseRateBpm: 82 }), at('h-2', 3, { vitals: { pulseRateBpm: null } })]
    const s = session({ vitals: { pulseRateBpm: 101.5 } })
    const shown = present({ ...s, assessment: stored({ uncomparedMetrics: [] }) }, thin)
    expect(shown?.uncomparedNote).toBeNull()
    expect(shown?.drift).toBe(
      'Scored again now, it would read “Not enough to say”, because pulse could not be compared ' +
        'with their usual.',
    )
  })

  it('never drifts a seeded card, which is already scored when shown', () => {
    const s = { ...session({ seeded: true, vitals: { breathingRateBrpm: 5 } }), assessment: stored({}) }
    expect(present(s, history(5))?.drift).toBeNull()
  })

  it('scores each card in presentAll against only the check-ins before it', () => {
    const early = at('early', 1)
    const later = at('later', 2)
    const shown = presentAll([
      { ...later, assessment: stored({}) },
      {
        ...early,
        assessment: stored({
          flag: 'insufficient-signal',
          baselineSessions: 0,
          summary: 'Still learning their normal — 0 of 3 check-ins needed before daily comparisons start.',
        }),
      },
    ])
    // Scored against the later card too, it would say 1 of 3, and drift.
    expect(shown.get('early')?.drift).toBeNull()
    expect(shown.get('later')?.drift).toMatch(/would read “Too early to compare”/)
  })

  it('labels a card withheld while learning "Too early to compare", apart from an unusable one (KV-17)', () => {
    const learning = { ...session(), assessment: scoreSession(session(), history(1)) }
    expect(present(learning, history(1))?.label).toBe('Too early to compare')
    const unusable = { ...session({ vitals: { confidence: 0.2 } }), assessment: scoreSession(session({ vitals: { confidence: 0.2 } }), history(5)) }
    expect(present(unusable, history(5))?.label).toBe('Not enough to say')
    // Recovered from an older record's summary, too.
    const old = {
      ...session(),
      assessment: stored({
        flag: 'insufficient-signal',
        baselineSessions: 1,
        summary: 'Still learning their normal — 1 of 3 check-ins needed before daily comparisons start.',
      }),
    }
    expect(present(old, history(1))?.label).toBe('Too early to compare')
    // A reason that cannot be recovered keeps the flag's own label.
    const unknown = { ...session(), assessment: stored({ flag: 'insufficient-signal', summary: 'x' }) }
    expect(present(unknown, history(5))?.label).toBe('Not enough to say')
    expect(present({ ...session(), assessment: scoreSession(session(), history(5)) }, history(5))?.label).toBe(
      'Looks normal',
    )
  })

  it('says when the label would change though the flag would not (KV-17 review)', () => {
    // Stored as withheld while learning; today's scorer, against a mature
    // history with a thin pulse, withholds it as partly compared instead.
    const thin = [...history(2, { pulseRateBpm: 82 }), at('h-2', 3, { vitals: { pulseRateBpm: null } })]
    const learning = stored({
      flag: 'insufficient-signal',
      withheld: 'still-learning',
      baselineSessions: 2,
      summary: 'x',
    })
    const shown = present({ ...session({ vitals: { pulseRateBpm: 101.5 } }), assessment: learning }, thin)
    expect(shown?.label).toBe('Too early to compare')
    expect(shown?.drift).toBe(
      'Scored again now, it would read “Not enough to say”, because pulse could not be compared ' +
        'with their usual (below).',
    )
  })

  it('scores each card in presentAll against its own person’s check-ins only', () => {
    // Five earlier check-ins, all someone else's: this person is still learning.
    const others = history(5).map((s) => ({ ...s, personId: 'someone-else' }))
    const mine = at('mine', 20)
    const learning = scoreSession(mine, [])
    const shown = presentAll([...others, { ...mine, assessment: learning }])
    expect(shown.get('mine')?.drift).toBeNull()
    expect(shown.get('mine')?.summary).toBe(learning.summary)
  })

  it('scores a seeded card itself, so it needs no verdict stored first', () => {
    // As `seedDemoHistory` writes it: no assessment at all.
    const seeded = { ...at('seed', 20, { seeded: true }), assessment: undefined }
    const card = presentAll([...history(5), seeded]).get('seed')
    expect(card?.flag).toBe('normal')
    expect(card?.summary).toBe('A normal day for them.')
    // A real check-in with no verdict is still nothing to show.
    expect(presentAll([{ ...at('real', 20), assessment: undefined }]).get('real')).toBeUndefined()
  })

  it('hands over a record it cannot present and presents the rest, given somewhere to say so (review of #164)', () => {
    // A stored verdict without its fired rules: `present` cannot read it.
    const damaged = {
      ...at('damaged', 10),
      assessment: { flag: 'normal', summary: 'x' } as unknown as SessionRecord['assessment'],
    }
    const after = { ...at('after', 20), assessment: scoreSession(at('after', 20), history(5)) }
    const records = [...history(5), damaged, after]

    const failed: string[] = []
    const shown = presentAll(records, (record) => failed.push(record.id))
    expect(failed).toEqual(['damaged'])
    expect(shown.has('damaged')).toBe(false)
    expect(shown.get('after')?.summary).toBeDefined()
    // With nowhere to say so, it throws, as it always did.
    expect(() => presentAll(records)).toThrow(TypeError)
  })
})

describe('learningStatus: where the baseline is now (KV-17)', () => {
  it('says how far the baseline has to go, counting the history as it is now', () => {
    expect(learningStatus(history(2), 'test-person', 'Margaret')).toBe(
      'Still learning Margaret’s usual — 2 of 3 usable check-ins so far.',
    )
    // Refusals only: nothing usable yet, but something to explain.
    expect(learningStatus(refusedCaptures(1), 'test-person', 'Margaret')).toBe(
      'Still learning Margaret’s usual — 0 of 3 usable check-ins so far. 1 check-in could not ' +
        'be used, so it is not counted.',
    )
  })

  it('says nothing for a person with no check-ins, so no caller has to hide "0 of 3" (KV-17 review)', () => {
    expect(learningStatus([], 'test-person', 'Margaret')).toBeNull()
    const others = history(1).map((r) => ({ ...r, personId: 'someone-else' }))
    expect(learningStatus(others, 'test-person', 'Margaret')).toBeNull()
  })

  it('never shows over seeded data, which is always past it', () => {
    // Why it carries no seeded disclosure (KV-53): the demo's fortnight alone
    // is past the line, before any real check-in is added.
    const seeded = seedDemoHistory()
    // Theirs, so the null below is "past the line", not "no check-ins".
    expect(seeded.length).toBeGreaterThan(0)
    expect(seeded.every((r) => r.personId === DEMO_PERSON_ID)).toBe(true)
    expect(learningStatus(seeded, DEMO_PERSON_ID, 'Margaret')).toBeNull()
  })

  it('says why the count is lower than the check-ins done', () => {
    expect(learningStatus([...refusedCaptures(4), ...history(2)], 'test-person', 'Margaret')).toBe(
      'Still learning Margaret’s usual — 2 of 3 usable check-ins so far. 4 check-ins could not ' +
        'be used, so they are not counted.',
    )
    expect(learningStatus([...refusedCaptures(1), ...history(1)], 'test-person', 'Margaret')).toBe(
      'Still learning Margaret’s usual — 1 of 3 usable check-ins so far. 1 check-in could not ' +
        'be used, so it is not counted.',
    )
  })

  it('stays at 3 of 3, when nothing has been compared yet, and goes away once one has', () => {
    // The check-in after the third usable one is the first compared (KV-17 review).
    expect(learningStatus(history(MIN_BASELINE_SESSIONS), 'test-person', 'Margaret')).toBe(
      'Margaret’s usual is ready — 3 of 3 usable check-ins so far. The next check-in will be ' +
        'the first compared with it.',
    )
    const fourth = session({ id: 'fourth', capturedAt: '2026-12-01T09:00:00.000Z' })
    expect(scoreSession(fourth, history(MIN_BASELINE_SESSIONS)).flag).toBe('normal')
    expect(learningStatus([...history(MIN_BASELINE_SESSIONS), fourth], 'test-person', 'Margaret')).toBeNull()
  })

  it('counts only this person', () => {
    const others = history(5).map((r) => ({ ...r, personId: 'someone-else' }))
    expect(learningStatus([...others, ...history(1)], 'test-person', 'Margaret')).toMatch(/1 of 3/)
  })

  it('says nothing relative to now', () => {
    for (const records of [history(1), [...refusedCaptures(3), ...history(2)]]) {
      expect(learningStatus(records, 'test-person', 'Margaret')).not.toMatch(RELATIVE_TIME)
    }
  })
})

describe('how far back a card’s usual reaches (KV-154)', () => {
  const SEP_30 = '2026-09-30T09:00:00.000Z'
  const DAY = 86_400_000
  const daysBefore = (iso: string, days: number) =>
    new Date(Date.parse(iso) - days * DAY).toISOString()
  /** `n` usable check-ins, `everyDays` apart, the newest `lastGap` days before `SEP_30`. */
  const spread = (n: number, everyDays: number, lastGap = 1): SessionRecord[] =>
    Array.from({ length: n }, (_, i) =>
      session({ id: `s-${i}`, capturedAt: daysBefore(SEP_30, lastGap + (n - 1 - i) * everyDays) }),
    )
  const scoredAt = (prior: SessionRecord[]) => {
    const s = session({ id: 'now', capturedAt: SEP_30 })
    return { ...s, assessment: scoreSession(s, prior) }
  }
  const note = (prior: SessionRecord[]) =>
    staleUsualDisclosure(scoredAt(prior).assessment, SEP_30)

  it('stores the window’s oldest and newest check-in', () => {
    const prior = spread(5, 3)
    expect(scoredAt(prior).assessment.baselineSpan).toEqual({
      from: prior[0]?.capturedAt,
      to: prior[4]?.capturedAt,
    })
    expect(scoredAt([]).assessment.baselineSpan).toBeUndefined()
  })

  it('tells a stale usual from a spread one, which one distance could not (review of #158)', () => {
    // Fourteen daily check-ins in January, then this one in September.
    expect(note(spread(14, 1, 250))).toBe(
      'Their usual here is 14 check-ins, the most recent of them 8 months before this one.',
    )
    // Fourteen spread over the same months, at a steady cadence: not stale.
    expect(note(spread(14, 20))).toBeNull()
    // Monthly for a year: a month's gap after a year-long usual is its rhythm.
    expect(note(spread(14, 30, 30))).toBeNull()
  })

  it('stays off every card at a regular cadence', () => {
    for (const every of [1, 3.5, 7]) expect(note(spread(14, every))).toBeNull()
  })

  it('needs the gap past four weeks, as well as past the stretch the usual covers', () => {
    // A three-day usual, then a gap of exactly four weeks: under the line.
    expect(note(spread(4, 1, USUAL_SPAN_NOTE_AFTER_DAYS))).toBeNull()
    expect(note(spread(4, 1, USUAL_SPAN_NOTE_AFTER_DAYS + 1))).toBe(
      'Their usual here is 4 check-ins, the most recent of them 4 weeks before this one.',
    )
  })

  it('says a year as a year, in calendar months below it, and never more than it was', () => {
    expect(note(spread(4, 1, 365))).toBe(
      'Their usual here is 4 check-ins, the most recent of them over a year before this one.',
    )
    // 364 days back from Sep 30 is Oct 1 the year before: eleven calendar months.
    expect(note(spread(4, 1, 364))).toMatch(/11 months before this one/)
    expect(note(spread(4, 1, 800))).toMatch(/over 2 years before this one/)
    expect(note(spread(4, 1, 58))).toMatch(/8 weeks before this one/)
  })

  it('appears only where the card leans on the baseline', () => {
    const s = session({ id: 'now', capturedAt: SEP_30, vitals: { confidence: 0.2 } })
    expect(staleUsualDisclosure(scoreSession(s, spread(5, 1, 200)), SEP_30)).toBeNull()
    expect(note(spread(2, 1, 200))).toBeNull()
  })

  it('says nothing on a date it cannot read, rather than calling the usual recent', () => {
    const card = scoredAt(spread(5, 1, 200)).assessment
    expect(staleUsualDisclosure(card, 'not a date')).toBeNull()
    expect(staleUsualDisclosure({ ...card, baselineSpan: { from: 'x', to: 'y' } }, SEP_30)).toBeNull()
  })

  it('says nothing when every check-in behind it was seeded, which the seeded note already says', () => {
    const seeded = spread(14, 1, 90).map((r) => ({ ...r, seeded: true }))
    expect(note(seeded)).toBeNull()
    // Partly seeded: still said, beside the seeded note.
    const mixed = [
      ...seeded.slice(0, 10),
      ...spread(4, 1, 90).map((r, i) => ({ ...r, id: `real-${i}` })),
    ]
    expect(note(mixed)).toMatch(/^Their usual here is 14 check-ins, the most recent of them 2 months/)
  })

  it('finds an older card’s span by scoring it again, only when the rescore counts what the card did', () => {
    const prior = spread(6, 1, 120)
    const { baselineSpan: _dropped, ...old } = scoredAt(prior).assessment
    const card = { ...session({ id: 'now', capturedAt: SEP_30 }), assessment: old }
    expect(present(card, prior)?.spanNote).toBe(
      'Their usual here is 6 check-ins, the most recent of them 3 months before this one.',
    )
    // Two of its sessions since lost (a restored backup): the stored count and
    // a rescored span would never have held together, so nothing is said.
    expect(present(card, prior.slice(2))?.spanNote).toBeNull()
    const seeded = present({ ...session({ id: 'now', capturedAt: SEP_30, seeded: true }) }, prior)
    expect(seeded?.spanNote).toBeNull()
  })

  it('records a span only with baseline sessions, so an absent one on a compared card is an older record', () => {
    // The invariant `present` relies on when it recovers a missing span: a
    // verdict with no baseline sessions never leans on the baseline.
    const none = [
      scoredAt([]).assessment,
      scoreSession(session({ vitals: { confidence: 0.2 } }), []),
    ]
    for (const a of none) {
      expect(a.baselineSpan).toBeUndefined()
      expect(a.flag).toBe('insufficient-signal')
    }
  })

  it('says nothing relative to now on a card', () => {
    for (const gap of [40, 200, 400, 900]) {
      const line = note(spread(4, 1, gap))
      expect(line).not.toBeNull()
      expect(line).not.toMatch(RELATIVE_TIME)
    }
  })
})

describe('usualReachStatus: how far back the usual reaches, said once (KV-154)', () => {
  const NOW = new Date('2026-09-30T09:00:00.000Z')
  const spreadTo = (n: number, everyDays: number, lastGap = 1) =>
    Array.from({ length: n }, (_, i) =>
      session({
        id: `r-${i}`,
        capturedAt: new Date(
          NOW.getTime() - (lastGap + (n - 1 - i) * everyDays) * 86_400_000,
        ).toISOString(),
      }),
    )

  it('says it once, at a cadence that would put it on every card', () => {
    expect(usualReachStatus(spreadTo(20, 3.5), 'test-person', 'Margaret', NOW)).toBe(
      'Margaret’s usual is the last 14 usable check-ins reaching back 6 weeks.',
    )
  })

  it('says when the most recent of them is long gone', () => {
    expect(usualReachStatus(spreadTo(14, 1, 250), 'test-person', 'Margaret', NOW)).toBe(
      'Margaret’s usual is the last 14 usable check-ins reaching back 8 months; the most recent ' +
        'was 8 months ago.',
    )
  })

  it('says nothing within four weeks, while learning, or over the demo alone', () => {
    expect(usualReachStatus(spreadTo(14, 1), 'test-person', 'Margaret', NOW)).toBeNull()
    expect(usualReachStatus(spreadTo(3, 30), 'test-person', 'Margaret', NOW)).toBeNull()
    const demo = spreadTo(14, 1, 90).map((r) => ({ ...r, seeded: true }))
    expect(usualReachStatus(demo, 'test-person', 'Margaret', NOW)).toBeNull()
    const mixed = [...demo.slice(4), ...spreadTo(4, 1, 40).map((r, i) => ({ ...r, id: `x-${i}` }))]
    expect(usualReachStatus(mixed, 'test-person', 'Margaret', NOW)).toBe(
      'Margaret’s usual is the last 14 usable check-ins, 10 of them seeded demo data, reaching ' +
        'back 3 months.',
    )
  })

  it('counts only this person', () => {
    const others = spreadTo(20, 3.5).map((r) => ({ ...r, personId: 'someone-else' }))
    expect(usualReachStatus(others, 'test-person', 'Margaret', NOW)).toBeNull()
  })
})
