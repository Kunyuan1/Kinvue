import { computeBaseline, MIN_BASELINE_SESSIONS, type Baseline } from '../baseline'
import type {
  Assessment,
  ComparedMetric,
  FiredRule,
  SessionRecord,
} from '../session/types'
import { unusableReason, type UnusableReason } from '../session/usable'
import { ALL_RULES, BASELINE_RULE_IDS, uncomparedMetrics, type Rule } from './rules'

export { ALL_RULES, BASELINE_RULE_IDS, uncomparedMetrics } from './rules'
export type { Rule, RuleContext } from './rules'

/**
 * Summed severity at or above this is `elevated`. Tuned so that the
 * combination the whole app exists to catch — an HRV drop alongside poor sleep
 * and pain — clears it, while any single soft answer-only signal does not.
 */
export const ELEVATED_SEVERITY_THRESHOLD = 0.6

/** What an assessment's fired rules sum to: the number compared against the threshold. */
export function totalSeverity(assessment: Assessment): number {
  return assessment.firedRules.reduce((sum, rule) => sum + rule.severity, 0)
}

export {
  hasScorableVitals,
  MIN_CAPTURE_CONFIDENCE,
  MIN_CAPTURE_SECONDS,
  unusableReason,
} from '../session/usable'
export type { UnusableReason } from '../session/usable'

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
    'The camera ran but no reading came out of it, so this check-in is not being compared.',
  'too-short':
    'The camera did not run for long enough to use, so this check-in is not being compared.',
  unrated:
    'The camera did not say how reliable this reading was, so this check-in is not being compared.',
  'low-confidence':
    'The camera reading was not clear enough to use, so this check-in is not being compared.',
}

function fire(rules: readonly Rule[], session: SessionRecord, baseline: Baseline): FiredRule[] {
  return rules
    .map((rule) => rule.evaluate({ session, baseline }))
    .filter((r): r is FiredRule => r !== null)
    .sort((a, b) => b.severity - a.severity)
}

function summarise(flag: Assessment['flag'], fired: FiredRule[]): string {
  if (flag === 'insufficient-signal') {
    // Reached only by KV-87's withheld verdict: the other withheld paths write
    // their own summary. Not "Not enough to say", which the card's label has
    // just said — this says *why*, and the note under it says which metric.
    return 'Only partly compared with their usual — see the note below.'
  }
  if (flag === 'normal') {
    return fired.length === 0
      ? 'A normal day for them.'
      : 'Broadly normal, with one or two things worth noting.'
  }
  const top = fired[0]
  return top === undefined
    ? 'Different from their usual.'
    : `Different from their usual — ${top.title.toLowerCase()}.`
}

/** True when anything this assessment says out loud rests on the baseline. */
function restsOnBaseline(assessment: Assessment): boolean {
  if (assessment.flag !== 'insufficient-signal') return true
  // Two ways a withheld verdict carries a rule that quotes "their usual".
  // Since KV-87, a day whose compared metrics fired lightly is withheld when
  // another measured metric had no usual — breathing's rule is on the card,
  // and the usual it quotes may be seeded. And records scored before KV-71
  // can carry one: the disclosure is composed where the card is shown, not
  // frozen into the record, so old assessments are read by today's code.
  // Deleting this would silently drop the seeded disclosure from both.
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

const METRIC_NAME: Record<ComparedMetric, string> = {
  pulse: 'pulse',
  breathing: 'breathing rate',
  hrv: 'HRV',
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** "a", "a and b", "a, b and c". */
function listOf(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`
}

/**
 * The sentence naming a metric that was measured but never compared, or null
 * (KV-87).
 *
 * "Looks normal" is an active claim that the check-in was checked against
 * their usual. A pulse of 102 against a usual of 82 said nothing on a card
 * reading "A normal day for them" because pulse had two earlier readings and
 * three are needed — the rule correctly held back, and the verdict did not
 * notice. So a would-be `normal` with such a metric is withheld, and this
 * says which metric and why. An `elevated` verdict stands, since it rests on
 * what *was* compared, and still names the gap.
 *
 * Composed from the stored counts where the card is shown, like the seeded
 * disclosure, so the wording can change without rescoring. No relative time
 * words (KV-93): "at this check-in", never "today".
 */
export function uncomparedDisclosure(assessment: Assessment): string | null {
  const { flag, uncomparedMetrics: gaps } = assessment
  if (gaps === undefined) {
    // Only a verdict that claims a comparison has anything unknown to admit.
    return flag === 'insufficient-signal'
      ? null
      : 'Whether every reading at this check-in was compared with their usual was not ' +
          'recorded when it was scored.'
  }
  if (gaps.length === 0) return null

  const names = gaps.map((g) => METRIC_NAME[g.metric])
  const counts: string[] = gaps.map((g, i) =>
    i === 0
      ? `${gaps.length === 1 ? 'it' : names[i]} had ${g.readings} of the ${g.needed} readings needed to know it`
      : `${names[i]} had ${g.readings} of ${g.needed}`,
  )
  const head =
    `${capitalise(listOf(names))} ${gaps.length === 1 ? 'was' : 'were'} measured at this ` +
    `check-in but not compared with their usual: ${listOf(counts)}.`
  return flag === 'insufficient-signal' ? `${head} So this check-in is not being called normal.` : head
}

/**
 * The seeded disclosure a card should show, or null (KV-103).
 *
 * A card that is itself seeded demo data says so in its own label, so it
 * carries no disclosure: the sentence exists for a *real* capture compared
 * against invented days, which otherwise looks measured, and scoring the demo
 * on display would put nine copies of it on the page and bury that one. Every
 * other card gets exactly `seededBaselineDisclosure`.
 */
export function seededDisclosureFor(session: SessionRecord): string | null {
  if (session.seeded === true || session.assessment === undefined) return null
  return seededBaselineDisclosure(session.assessment)
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
  const uncompared = uncomparedMetrics(session, baseline)
  // A would-be `normal` with a measured metric nobody compared is withheld
  // (KV-87): "normal" would claim a check that did not happen for that metric,
  // which is the reassuring-and-wrong direction. `elevated` stands — it rests
  // on what was compared, and withholding it would hide a real signal to cover
  // a missing one. Either way `uncomparedDisclosure` names the gap.
  const flag: Assessment['flag'] =
    total >= ELEVATED_SEVERITY_THRESHOLD
      ? 'elevated'
      : uncompared.length > 0
        ? 'insufficient-signal'
        : 'normal'

  return {
    flag,
    firedRules: fired,
    summary: summarise(flag, fired),
    baselineSessions: baseline.sessions,
    baselineSeededSessions: baseline.seededSessions,
    uncomparedMetrics: uncompared,
  }
}
