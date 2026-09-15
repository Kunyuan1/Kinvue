import { computeBaseline, MIN_BASELINE_SESSIONS, type Baseline } from '../baseline'
import type { Assessment, FiredRule, SessionRecord } from '../session/types'
import { ALL_RULES, type Rule } from './rules'

export { ALL_RULES } from './rules'
export type { Rule, RuleContext } from './rules'

/**
 * Summed severity at or above this is `elevated`. Tuned so that the
 * combination the whole app exists to catch — an HRV drop alongside poor sleep
 * and pain — clears it, while any single soft answer-only signal does not.
 */
export const ELEVATED_SEVERITY_THRESHOLD = 0.6

/** Below this mean SDK confidence the capture is not scored at all. */
export const MIN_CAPTURE_CONFIDENCE = 0.5

/** Captures shorter than this are not scored. The UI asks for ~30s. */
export const MIN_CAPTURE_SECONDS = 20

function captureIsUsable(session: SessionRecord): boolean {
  const { confidence, durationSec, pulseRateBpm, breathingRateBrpm, hrvRmssdMs } =
    session.vitals
  if (confidence < MIN_CAPTURE_CONFIDENCE) return false
  if (durationSec < MIN_CAPTURE_SECONDS) return false
  return (
    pulseRateBpm !== null || breathingRateBrpm !== null || hrvRmssdMs !== null
  )
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
  if (!captureIsUsable(session)) {
    return {
      flag: 'insufficient-signal',
      firedRules: [],
      summary: 'The camera reading was not clear enough to use today.',
      baselineSessions: baseline.sessions,
    }
  }

  const fired = fire(ALL_RULES, session, baseline)

  // Without enough history there is no "usual" to deviate from. The
  // answer-based rules still ran and are still shown; the verdict is withheld.
  if (baseline.sessions < MIN_BASELINE_SESSIONS) {
    return {
      flag: 'insufficient-signal',
      firedRules: fired,
      summary:
        `Still learning their normal — ${baseline.sessions} of ` +
        `${MIN_BASELINE_SESSIONS} check-ins needed before daily comparisons start.`,
      baselineSessions: baseline.sessions,
    }
  }

  const total = fired.reduce((sum, r) => sum + r.severity, 0)
  const flag = total >= ELEVATED_SEVERITY_THRESHOLD ? 'elevated' : 'normal'

  return {
    flag,
    firedRules: fired,
    summary: summarise(flag, fired),
    baselineSessions: baseline.sessions,
  }
}
