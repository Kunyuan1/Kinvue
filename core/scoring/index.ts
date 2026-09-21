import { computeBaseline, MIN_BASELINE_SESSIONS, type Baseline } from '../baseline'
import type { Assessment, FiredRule, SessionRecord, Vitals } from '../session/types'
import { ALL_RULES, BASELINE_RULE_IDS, type Rule } from './rules'

export { ALL_RULES, BASELINE_RULE_IDS } from './rules'
export type { Rule, RuleContext } from './rules'

/**
 * Summed severity at or above this is `elevated`. Tuned so that the
 * combination the whole app exists to catch — an HRV drop alongside poor sleep
 * and pain — clears it, while any single soft answer-only signal does not.
 */
export const ELEVATED_SEVERITY_THRESHOLD = 0.6

/** Below this mean SDK confidence the capture is not scored at all. */
export const MIN_CAPTURE_CONFIDENCE = 0.5

/**
 * Captures shorter than this are not scored.
 *
 * Load-bearing since captures became adaptive (KV-63). A fixed clock plus
 * `SHORTEST_USEFUL_SECONDS` made this unreachable; an early stop can end a
 * capture as soon as every metric has arrived, so `captureVitals` checks the
 * seconds recorded so far against this before it stops. Without that, a
 * capture that collected all three metrics quickly would be stored as
 * `too-short` — the verdict for one that collected nothing.
 */
export const MIN_CAPTURE_SECONDS = 20

/**
 * Whether a capture measured anything a rule can read.
 *
 * `hrvSdnnMs` is deliberately not in the list: nothing scores on it, so a
 * capture that produced only SDNN has nothing to say. Exported because the
 * renderer offers a retake on exactly this question, and a second copy of the
 * list would drift — a capture the scorer would happily score must never be
 * shown to the person as "nothing was measured".
 */
export function hasScorableVitals(vitals: Vitals): boolean {
  return (
    vitals.pulseRateBpm !== null ||
    vitals.breathingRateBrpm !== null ||
    vitals.hrvRmssdMs !== null
  )
}

/** Why a capture cannot be scored. Null means it can. */
export type UnusableReason = 'nothing-measured' | 'too-short' | 'unrated' | 'low-confidence'

/**
 * The first reason this capture cannot be scored, or null when it can.
 *
 * A reason rather than a boolean because the card has to say which one
 * happened. A capture cut short at 8s and a capture the SDK rated 0.2 are
 * different things for a caregiver to be told, and the same argument that
 * separates "unrated" from "judged and found poor" separates these.
 *
 * Order is deliberate, and it is not the order of the thresholds. The reason
 * given is the one that explains the most and that someone could act on:
 * nothing measured at all comes first because the other three describe a
 * reading; a short capture comes before either confidence branch because a
 * camera that ran for 8s is *why* the reading is thin or unrated, and it is
 * the one thing the person in front of it could have done differently.
 */
export function unusableReason(vitals: Vitals): UnusableReason | null {
  const { confidence, durationSec } = vitals
  if (!hasScorableVitals(vitals)) return 'nothing-measured'
  if (durationSec < MIN_CAPTURE_SECONDS) return 'too-short'
  // Unrated is not usable (KV-12). The SDK sometimes reports a rate without
  // rating it at all, and scoring that would present a number as reliable on
  // the grounds that nothing said otherwise — the reassuring direction, which
  // is the worse one. Withholding says the true thing: we cannot tell today.
  //
  // Tested for shape, not for null: `store.ts` casts parsed JSON to
  // `SessionRecord` unvalidated, so a record missing the key reads as
  // `undefined`, and `undefined < 0.5` is false — an absent confidence would
  // otherwise score as fully vouched-for, the exact failure KV-12 closes.
  if (typeof confidence !== 'number') return 'unrated'
  if (confidence < MIN_CAPTURE_CONFIDENCE) return 'low-confidence'
  return null
}

/**
 * What the card says when the capture could not be used.
 *
 * Each states its own consequence. Three of these used to describe the failure
 * and stop, leaving the caregiver to infer what it meant for the day; the
 * fourth said it outright. Saying it every time costs four words and removes
 * the inference.
 */
const UNUSABLE_SUMMARY: Record<UnusableReason, string> = {
  'nothing-measured':
    'The camera ran but no reading came out of it, so today is not being compared.',
  'too-short': 'The camera did not run for long enough to use, so today is not being compared.',
  unrated:
    'The camera did not say how reliable this reading was, so today is not being compared.',
  'low-confidence':
    'The camera reading was not clear enough to use, so today is not being compared.',
}

function fire(rules: readonly Rule[], session: SessionRecord, baseline: Baseline): FiredRule[] {
  return rules
    .map((rule) => rule.evaluate({ session, baseline }))
    .filter((r): r is FiredRule => r !== null)
    .sort((a, b) => b.severity - a.severity)
}

function summarise(flag: Assessment['flag'], fired: FiredRule[]): string {
  if (flag === 'insufficient-signal') {
    return 'Not enough to say today — see the note below.'
  }
  if (flag === 'normal') {
    return fired.length === 0
      ? 'Today looks like a normal day for them.'
      : 'Today looks broadly normal, with one or two things worth noting.'
  }
  const top = fired[0]
  return top === undefined
    ? 'Today looks different from usual.'
    : `Today looks different from usual — ${top.title.toLowerCase()}.`
}

/** True when anything this assessment says out loud rests on the baseline. */
function restsOnBaseline(assessment: Assessment): boolean {
  if (assessment.flag !== 'insufficient-signal') return true
  // **Unreachable for anything scored from now on, and load-bearing anyway.**
  // Since KV-71 no withheld verdict this scorer produces carries a rule that
  // quotes "their usual": the unusable-capture path fires nothing, and a rule
  // with no usual to quote does not fire. Records scored *before* KV-71 can
  // carry one, and those are exactly what reaches this line — the disclosure
  // is composed where the card is shown, not frozen into the record, so old
  // assessments are read by today's code. Deleting this would silently drop
  // the seeded disclosure from stored history.
  return assessment.firedRules.some((r) => BASELINE_RULE_IDS.has(r.id))
}

/**
 * The sentence disclosing that seeded history fed what this card claims, or
 * null when there is nothing to disclose (KV-53).
 *
 * "Their usual" is the whole claim a comparison makes. When part of that usual
 * was invented by `core/seed`, the sentence naming it belongs wherever the
 * claim is shown — the reading is real, so the card would otherwise look
 * exactly like one backed by measurement. The numbers are in it for the same
 * reason every fired rule carries its own.
 *
 * Composed here rather than baked into `summary` at score time. The count is
 * what is stored, so the wording can be corrected without rescoring history,
 * and a record written before the count existed can say *that* instead of
 * quietly reading as "none" — absent is unknown, not zero. Every surface that
 * renders an assessment calls this, including the caregiver's client later.
 */
export function seededBaselineDisclosure(assessment: Assessment): string | null {
  if (!restsOnBaseline(assessment)) return null

  const { baselineSeededSessions: seeded, baselineSessions: sessions } = assessment
  if (seeded === undefined) {
    return 'Whether seeded demo data fed this comparison was not recorded when this check-in was scored.'
  }
  if (seeded === 0) return null
  return seeded === sessions
    ? `Their usual here is seeded demo data — all ${sessions} check-ins behind this ` +
        'comparison were invented, not measured.'
    : `Their usual here is partly seeded demo data — ${seeded} of the ${sessions} ` +
        'check-ins behind this comparison were invented, not measured.'
}

/**
 * Score one check-in against the person's own history.
 *
 * `history` is every prior session for this person; the session being scored
 * must not appear in it. Returns an assessment that always carries the rules
 * that fired, including when the verdict is `normal` — a caregiver seeing
 * "normal" alongside the two things that *did* register trusts it more than a
 * bare green tick, and the explanation is the point of the product.
 */
export function scoreSession(
  session: SessionRecord,
  history: readonly SessionRecord[],
): Assessment {
  const baseline = computeBaseline([...history])

  // An unusable capture is reported as such rather than scored on the answers
  // alone — a flag that silently means "we only asked three questions" would
  // misrepresent what the app actually measured.
  const unusable = unusableReason(session.vitals)
  if (unusable !== null) {
    return {
      flag: 'insufficient-signal',
      firedRules: [],
      // Four different things, said differently: nothing measured, a capture cut
      // short, a reading the camera judged and found poor, and one it never
      // judged at all. Collapsing any of them hides which one happened.
      summary: UNUSABLE_SUMMARY[unusable],
      baselineSessions: baseline.sessions,
      baselineSeededSessions: baseline.seededSessions,
    }
  }

  // Every rule runs. A rule that quotes "their usual" decides for itself
  // whether it has one, per metric, in `canBeCalledUsual` (KV-71) — and since
  // a metric's `Stat.n` can never exceed `baseline.sessions`, a metric is never
  // mature on a card that is not. Filtering here as well would restate that
  // more weakly, in sessions rather than in readings.
  //
  // The sentence below has always said the answer rules are what still ran.
  // Until KV-71 every rule ran, and the card made the comparison it had just
  // said it could not make, in the next breath.
  const fired = fire(ALL_RULES, session, baseline)

  if (baseline.sessions < MIN_BASELINE_SESSIONS) {
    return {
      flag: 'insufficient-signal',
      firedRules: fired,
      summary:
        `Still learning their normal — ${baseline.sessions} of ` +
        `${MIN_BASELINE_SESSIONS} check-ins needed before daily comparisons start.`,
      baselineSessions: baseline.sessions,
      baselineSeededSessions: baseline.seededSessions,
    }
  }

  const total = fired.reduce((sum, r) => sum + r.severity, 0)
  const flag = total >= ELEVATED_SEVERITY_THRESHOLD ? 'elevated' : 'normal'

  return {
    flag,
    firedRules: fired,
    summary: summarise(flag, fired),
    baselineSessions: baseline.sessions,
    baselineSeededSessions: baseline.seededSessions,
  }
}
