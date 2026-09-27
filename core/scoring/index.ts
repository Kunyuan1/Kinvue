import { computeBaseline, MIN_BASELINE_SESSIONS, type Baseline } from '../baseline'
import type {
  Assessment,
  ComparedMetric,
  FiredRule,
  Flag,
  SessionRecord,
  UncomparedMetric,
  WithheldReason,
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

/**
 * The summary for a check-in that was compared, from the verdict the rules
 * reached *before* KV-87 withheld anything, and the gaps that withholding
 * rests on. Taking the gaps rather than the withheld flag ties the sentence
 * to the condition it describes: a later withheld case routed through here
 * cannot inherit "only partly compared" with no note beneath it, because the
 * type has no `insufficient-signal` to route.
 */
function summarise(
  scored: 'normal' | 'elevated',
  fired: FiredRule[],
  uncompared: readonly UncomparedMetric[],
): string {
  if (scored === 'normal' && uncompared.length > 0) {
    // Withheld (KV-87). Not "Not enough to say", which the card's label has
    // just said — this says *why*, and the note under it says which metric.
    return 'Only partly compared with their usual — see the note below.'
  }
  if (scored === 'normal') {
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
  // A verdict withheld by KV-87 still claims a comparison — "only partly
  // compared" says the other metrics *were* compared, against a usual that
  // may be seeded — whether or not any rule fired. `uncomparedMetrics` is
  // written only on the path that compared, so its presence is the marker;
  // the unusable and still-learning returns leave it absent.
  if (assessment.uncomparedMetrics !== undefined) return true
  // Records scored before KV-71 can carry a rule that quotes "their usual" on
  // a withheld verdict: the disclosure is composed where the card is shown,
  // not frozen into the record, so old assessments are read by today's code.
  // Deleting this would silently drop the seeded disclosure from them.
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

/** The unit a metric's mean is quoted in, as the rules that compare it quote it. */
const METRIC_UNIT: Record<ComparedMetric, string> = {
  pulse: 'bpm',
  breathing: 'breaths/min',
  hrv: 'ms',
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** "a", "a and b", "a, b and c". */
function listOf(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  // Never taken: the guard above proves the index. Here only for
  // `noUncheckedIndexedAccess`; were the guard to move, a name would vanish
  // from the sentence silently, so keep the two together.
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`
}

/**
 * What the thin history showed, as evidence with its weakness beside it:
 * "(those 2 averaged 82 bpm)". Never "their usual 82 bpm" — that is the claim
 * KV-71 forbids a history this short to make — but the number that makes the
 * reading above it mean something, which the counts alone withhold (KV-87
 * review). Nothing when there were no readings, or none was recorded.
 */
function whatItShowed(gap: UncomparedMetric): string {
  if (gap.mean === undefined || gap.readings === 0) return ''
  const value = `${Math.round(gap.mean)} ${METRIC_UNIT[gap.metric]}`
  return gap.readings === 1
    ? ` (that one was ${value})`
    : ` (those ${gap.readings} averaged ${value})`
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
  const counts: string[] = gaps.map((g, i) => {
    const who = gaps.length === 1 ? 'it' : names[i]
    const of = i === 0 ? `of the ${g.needed} readings needed to know it` : `of ${g.needed}`
    return `${who} had ${g.readings} ${of}${whatItShowed(g)}`
  })
  const head =
    `${capitalise(listOf(names))} ${gaps.length === 1 ? 'was' : 'were'} measured at this ` +
    `check-in but not compared with their usual: ${listOf(counts)}.`
  return flag === 'insufficient-signal'
    ? `${head} So this check-in is not being called normal.`
    : head
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
    // Four different things, said differently: nothing measured, a capture cut
    // short, a reading the camera judged and found poor, and one it never
    // judged at all. Collapsing any of them hides which one happened.
    return withSummary({
      flag: 'insufficient-signal',
      withheld: unusable,
      firedRules: [],
      baselineSessions: baseline.sessions,
      baselineSeededSessions: baseline.seededSessions,
      baselineRefusedSessions: baseline.refusedSessions,
    })
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
    return withSummary({
      flag: 'insufficient-signal',
      withheld: 'still-learning',
      firedRules: fired,
      baselineSessions: baseline.sessions,
      baselineSeededSessions: baseline.seededSessions,
      baselineRefusedSessions: baseline.refusedSessions,
    })
  }

  const total = fired.reduce((sum, r) => sum + r.severity, 0)
  const uncompared = uncomparedMetrics(session, baseline)
  // A would-be `normal` with a measured metric nobody compared is withheld
  // (KV-87): "normal" would claim a check that did not happen for that metric,
  // which is the reassuring-and-wrong direction. `elevated` stands — it rests
  // on what was compared, and withholding it would hide a real signal to cover
  // a missing one. Either way `uncomparedDisclosure` names the gap.
  const scored = total >= ELEVATED_SEVERITY_THRESHOLD ? 'elevated' : 'normal'
  const withheld = scored === 'normal' && uncompared.length > 0
  const facts = {
    firedRules: fired,
    baselineSessions: baseline.sessions,
    baselineSeededSessions: baseline.seededSessions,
    baselineRefusedSessions: baseline.refusedSessions,
    uncomparedMetrics: uncompared,
  }
  return withSummary(
    withheld
      ? { flag: 'insufficient-signal', withheld: 'uncompared', ...facts }
      : { flag: scored, ...facts },
  )
}

/**
 * The facts an assessment keeps, less its summary: what `summaryOf` reads. An
 * `insufficient-signal` verdict always says what withheld it, so the sentence
 * is never re-decided from anything that could have changed since.
 */
type AssessmentFacts = Omit<Assessment, 'summary' | 'flag' | 'withheld'> &
  (
    | { flag: 'normal' | 'elevated'; withheld?: undefined }
    | { flag: 'insufficient-signal'; withheld: WithheldReason }
  )

/**
 * The sentence at the top of a card, from the facts its assessment keeps.
 *
 * The one place the summary is decided. `scoreSession` writes a new card's
 * through it and `present` composes an old card's through it, so "a card
 * scored now composes to exactly what it stored" holds by construction rather
 * than by a mirror kept in step by hand (KV-138 review) — the objection
 * `BASELINE_RULE_IDS` makes to two encodings of one concept.
 */
function summaryOf(facts: AssessmentFacts): string {
  if (facts.flag !== 'insufficient-signal') return summarise(facts.flag, facts.firedRules, [])
  const { withheld } = facts
  if (withheld === 'still-learning') {
    return learningSummary(facts.baselineSessions, facts.baselineRefusedSessions)
  }
  if (withheld === 'uncompared') {
    return summarise('normal', facts.firedRules, facts.uncomparedMetrics ?? [])
  }
  return UNUSABLE_SUMMARY[withheld]
}

function withSummary(facts: AssessmentFacts): Assessment {
  return { ...facts, summary: summaryOf(facts) }
}

/**
 * The sentence for a check-in scored before there was enough history to
 * compare it (KV-100).
 *
 * About that check-in, not about the person's progress. It is stored and shown
 * under its date forever, and "…needed before daily comparisons start" was a
 * live status: on a dashboard read newest first, it sat under every card that
 * had since compared. Where the person is now belongs in one live place, the
 * dashboard header (#17). "Then" dates the count to the check-in.
 *
 * When earlier captures were refused, it says so: the count is of *usable*
 * check-ins since KV-72, and a caregiver who has done six and is shown two
 * should not have to connect that to four cards further down. Absent, the
 * count of refusals is unknown, and nothing is said about it.
 */
function learningSummary(sessions: number, refused: number | undefined): string {
  const count =
    `Not yet enough history to compare this check-in (${sessions} of ` +
    `${MIN_BASELINE_SESSIONS} usable check-ins then).`
  if (refused === undefined || refused === 0) return count
  return refused === 1
    ? `${count} 1 earlier camera reading could not be used, so it is not counted.`
    : `${count} ${refused} earlier camera readings could not be used, so they are not counted.`
}

/**
 * What the card's label says for each verdict. Here rather than in the card so
 * the drift line quotes the label a caregiver actually sees (KV-138).
 */
export const FLAG_LABEL: Record<Flag, string> = {
  normal: 'Looks normal',
  elevated: 'Looks different',
  'insufficient-signal': 'Not enough to say',
}

/** What a card shows for an assessment, composed now rather than read as stored. */
export interface Presentation {
  /**
   * The verdict the card shows: the one stored, or for a seeded card the one
   * today's rules give it (KV-103).
   */
  flag: Flag
  summary: string
  /** Each fired rule as stored, its words brought up to date where they can be. */
  firedRules: FiredRule[]
  /** The #87 note: which measured metrics went uncompared, or null. */
  uncomparedNote: string | null
  /** One line when today's scorer would say something different, or null. */
  drift: string | null
}

const ANSWER_RULES = ALL_RULES.filter((rule) => rule.compares === undefined)
const NO_BASELINE = computeBaseline([])

/**
 * Every fixed string KV-93 reworded, old to new, exactly as `0f92c51` changed
 * them — and the one withheld summary the scaffold wrote before KV-12 gave
 * each unusable capture its own (`e8e87a2`), less its "today". Frozen: it
 * describes records already written, and nothing written now needs it.
 */
const REWORDED: ReadonlyMap<string, string> = new Map([
  ['Has not eaten today', 'Had not eaten yet'],
  [
    'They reported sleeping poorly and being in pain today.',
    'At the check-in they reported being in pain, and sleeping poorly the night before.',
  ],
  ['They reported being in pain today.', 'At the check-in they reported being in pain.'],
  [
    'They reported sleeping poorly last night.',
    'At the check-in they reported sleeping poorly the night before.',
  ],
  ['They described their mood as low today.', 'At the check-in they described their mood as low.'],
  [
    'The camera reading was not clear enough to use today.',
    'The camera reading was not clear enough to use.',
  ],
])

/**
 * A stored string in today's words, where the words it had are known to have
 * changed. A comparison rule's explanation was built from numbers, so it is
 * not in the table: every stored form was "<metric> was <value> <unit> today,
 * …", and that one " today," is dropped.
 */
function inTodaysWords(text: string): string {
  return REWORDED.get(text) ?? text.replace(' today,', ',')
}

/**
 * A stored fired rule in today's words (KV-138). An answer rule that still
 * fires on these answers is evaluated again, and its current title and
 * explanation used. Anything else keeps its own text, brought up to date by
 * `inTodaysWords`: a comparison rule, whose usual is not stored, and an answer
 * rule today's engine no longer fires here or no longer has. Which it is does
 * not matter — the text it carries is what gets reworded, whatever its kind.
 * The severity is never touched: it is part of the verdict, which stands.
 */
function composeRule(session: SessionRecord, rule: FiredRule): FiredRule {
  const answer = ANSWER_RULES.find((candidate) => candidate.id === rule.id)
  const now = answer?.evaluate({ session, baseline: NO_BASELINE }) ?? null
  return now === null
    ? { ...rule, title: inTodaysWords(rule.title), explanation: inTodaysWords(rule.explanation) }
    : { ...rule, title: now.title, explanation: now.explanation }
}

/**
 * The withheld summaries written before `Assessment.withheld` existed, as
 * written, and the capture each describes. Frozen like `REWORDED`. The
 * scaffold's one sentence covered three reasons, so it is not here: see
 * `SCAFFOLD_UNUSABLE`.
 */
const UNUSABLE_BEFORE_WITHHELD: ReadonlyMap<string, UnusableReason> = new Map([
  // KV-12 to KV-93 (`8987dcc`).
  [
    'The camera ran but no reading came out of it, so today is not being compared.',
    'nothing-measured',
  ],
  [
    'The camera did not run for long enough to use, so today is not being compared.',
    'too-short',
  ],
  [
    'The camera did not say how reliable this reading was, so today is not being compared.',
    'unrated',
  ],
  [
    'The camera reading was not clear enough to use, so today is not being compared.',
    'low-confidence',
  ],
  // KV-93 to the KV-138 review (`0f92c51`).
  [
    'The camera ran but no reading came out of it, so this check-in is not being compared.',
    'nothing-measured',
  ],
  [
    'The camera did not run for long enough to use, so this check-in is not being compared.',
    'too-short',
  ],
  [
    'The camera did not say how reliable this reading was, so this check-in is not being compared.',
    'unrated',
  ],
  [
    'The camera reading was not clear enough to use, so this check-in is not being compared.',
    'low-confidence',
  ],
])

/**
 * The scaffold's withheld summary (`e8e87a2`), which said the capture was
 * unusable but not in which of three ways. It is kept as written, less its
 * "today", and only whether a capture was unusable at all is compared.
 */
const SCAFFOLD_UNUSABLE = 'The camera reading was not clear enough to use today.'

/** An unusable capture that the record does not say more about. */
type Recovered = WithheldReason | 'unusable'

const isUnusable = (why: Recovered | undefined): boolean =>
  why !== undefined && why !== 'still-learning' && why !== 'uncompared'

/**
 * Why a stored `insufficient-signal` verdict was withheld, as far as the
 * record says, or undefined when it cannot be recovered at all.
 *
 * Never asked of today's predicates: asked again, they can give a different
 * reason under the same flag, and the card would state a reason it was never
 * given (KV-138 review). A record scored before `withheld` was stored is read
 * from what it kept — a gap list means a metric went uncompared (KV-87), and
 * otherwise its summary is one of a closed set of sentences, the only trace of
 * which branch wrote it.
 */
function withheldOf(stored: Assessment): Recovered | undefined {
  const gaps = stored.uncomparedMetrics?.length ?? 0
  if (stored.withheld === 'uncompared') return gaps > 0 ? 'uncompared' : undefined
  if (stored.withheld !== undefined) return stored.withheld
  if (gaps > 0) return 'uncompared'
  // Written from the scaffold to KV-100; later records store `withheld`.
  if (stored.summary.startsWith('Still learning their normal — ')) return 'still-learning'
  if (stored.summary === SCAFFOLD_UNUSABLE) return 'unusable'
  return UNUSABLE_BEFORE_WITHHELD.get(stored.summary)
}

/**
 * The summary for a stored verdict, through the same `summaryOf` that wrote
 * it, so a card scored now composes to exactly what it stored and one scored
 * before KV-93 loses its "today". A withheld card whose reason the record does
 * not give keeps its own sentence, reworded where the words are known to have
 * changed — never a reason it was not given.
 */
function composeSummary(
  stored: Assessment,
  withheld: Recovered | undefined,
  firedRules: FiredRule[],
): string {
  if (stored.flag !== 'insufficient-signal') {
    return summaryOf({ ...stored, flag: stored.flag, withheld: undefined, firedRules })
  }
  return withheld === undefined || withheld === 'unusable'
    ? inTodaysWords(stored.summary)
    : summaryOf({ ...stored, flag: 'insufficient-signal', withheld, firedRules })
}

/**
 * What a card shows, composed when it is shown rather than read as it was
 * stored (KV-138, decided by the owner).
 *
 * **The verdict stands.** A card's flag and fired rules are what the app told
 * the caregiver that day, and history stays a record of that (append-only,
 * KV-25). **The words are composed now** from facts the record keeps, as the
 * seeded and uncompared notes already are (KV-53, KV-87), so a card scored
 * before a wording fix does not keep saying what that fix removed — "today"
 * under a date, most of all (KV-93).
 *
 * **When today's scorer would say something different, one line says so**,
 * rather than silently replacing what was shown: a different verdict, the
 * same verdict with different rules fired, or the same withheld verdict for a
 * different reason. The second matters as much: a rule that fires or stops
 * firing changes what the card says even when the flag does not —
 * `breathing-low` alone is under the threshold, so a fall it now catches
 * leaves the verdict `normal` and would otherwise go unmentioned.
 *
 * `prior` is this person's check-ins before this one, so the rescoring
 * compares it against the same history it had. A seeded card is scored here,
 * as it is shown (KV-103), so no caller has to have done that first; its
 * verdict is today's, so it never drifts.
 *
 * A record from before KV-87 has no stored `uncomparedMetrics`. Rather than
 * saying on every such card that it was "not recorded", the gaps are found by
 * scoring it again against the same history — which is what they would have
 * been — and the note appears only when there is one.
 */
export function present(
  session: SessionRecord,
  prior: readonly SessionRecord[],
): Presentation | null {
  const seeded = session.seeded === true
  const stored = seeded ? scoreSession(session, prior) : session.assessment
  if (stored === undefined) return null
  const rescored = seeded ? stored : scoreSession(session, prior)

  const firedRules = stored.firedRules.map((rule) => composeRule(session, rule))
  const withheld = stored.flag === 'insufficient-signal' ? withheldOf(stored) : undefined
  const summary = composeSummary(stored, withheld, firedRules)
  const gaps = stored.uncomparedMetrics ?? rescored.uncomparedMetrics
  const uncomparedNote =
    gaps === undefined ? null : uncomparedDisclosure({ ...stored, uncomparedMetrics: gaps })

  return {
    flag: stored.flag,
    summary,
    firedRules,
    uncomparedNote,
    drift: driftLine(
      { flag: stored.flag, withheld, firedRules, summary, noteGaps: gaps ?? [] },
      rescored,
    ),
  }
}

/** What the card shows, as `driftLine` compares it: the composed words, not the stored ones. */
interface Shown {
  flag: Flag
  /** Why a withheld card was withheld, as far as its record says. */
  withheld: Recovered | undefined
  firedRules: readonly FiredRule[]
  summary: string
  /** The gaps the uncompared note under it names. */
  noteGaps: readonly UncomparedMetric[]
}

/**
 * One line saying what today's scorer would say differently, or null when it
 * would say the same: "Scored again now, it would read “Looks different” —
 * breathing below usual." or "… it would also note breathing below usual."
 * Rule titles, lowercased, are the words the card already uses for them.
 *
 * It states an observation, not a cause. All it measures is that scoring this
 * check-in again, against the check-ins recorded before it, gives a different
 * answer. Today only a rule change does that — history is append-only and
 * `demo:seed` refuses a store that is not empty (`app/main/index.ts`) — but a
 * restored backup or a deleted record would too, and the line must stay true
 * then (KV-138 review).
 */
function driftLine(shown: Shown, rescored: Assessment): string | null {
  const prefix = 'Scored again now, it would'
  if (rescored.flag !== shown.flag) {
    return `${prefix} read “${FLAG_LABEL[rescored.flag]}”${driftReason(rescored, shown.noteGaps)}.`
  }
  // Same withheld verdict, different reason or count: the card's lead
  // sentence is what would change, and the flag and the rule ids cannot see
  // it. A record that says only "unusable" differs only if today's reason is
  // not one — its sentence was never more specific than that.
  const reasonChanged =
    shown.withheld === 'unusable'
      ? !isUnusable(rescored.withheld)
      : rescored.summary !== shown.summary
  if (shown.flag === 'insufficient-signal' && reasonChanged) {
    return `${prefix} say instead: “${rescored.summary}”`
  }
  const was = new Set(shown.firedRules.map((rule) => rule.id))
  const now = new Set(rescored.firedRules.map((rule) => rule.id))
  const titles = (rules: readonly FiredRule[]): string =>
    listOf(rules.map((rule) => rule.title.toLowerCase()))
  const added = rescored.firedRules.filter((rule) => !was.has(rule.id))
  const dropped = shown.firedRules.filter((rule) => !now.has(rule.id))
  const parts = [
    ...(added.length > 0 ? [`also note ${titles(added)}`] : []),
    ...(dropped.length > 0 ? [`no longer note ${titles(dropped)}`] : []),
  ]
  return parts.length === 0 ? null : `${prefix} ${parts.join(', and ')}.`
}

/**
 * Why today's verdict would differ, in the words the card already has for it.
 * An amber card names its top rule. A withheld one names what withheld it: the
 * metrics that had no usual, pointing at the note below only when that note
 * names the same ones; otherwise its own summary, which says it in full.
 */
function driftReason(rescored: Assessment, noteGaps: readonly UncomparedMetric[]): string {
  if (rescored.flag === 'elevated') {
    const top = rescored.firedRules[0]
    return top === undefined ? '' : ` — ${top.title.toLowerCase()}`
  }
  if (rescored.flag === 'normal') return ''
  if (rescored.withheld === 'uncompared') {
    const metrics = (gaps: readonly UncomparedMetric[]): string =>
      gaps.map((g) => g.metric).join()
    const gaps = rescored.uncomparedMetrics ?? []
    const below = metrics(gaps) === metrics(noteGaps) ? ' (below)' : ''
    const names = listOf(gaps.map((g) => METRIC_NAME[g.metric]))
    return `, because ${names} could not be compared with their usual${below}`
  }
  const why = rescored.summary.replace(/\.$/, '')
  return `: ${why.charAt(0).toLowerCase()}${why.slice(1)}`
}

/**
 * `present` for every card on the dashboard, each against the same person's
 * check-ins before it — `scoreSession`'s contract is one person's history, and
 * a caregiver's client will hold more than one person. Keyed by record id.
 */
export function presentAll(records: readonly SessionRecord[]): Map<string, Presentation> {
  const byTime = [...records].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const before = new Map<string, SessionRecord[]>()
  const shown = new Map<string, Presentation>()
  for (const record of byTime) {
    const prior = before.get(record.personId) ?? []
    const presentation = present(record, prior)
    if (presentation !== null) shown.set(record.id, presentation)
    before.set(record.personId, [...prior, record])
  }
  return shown
}
