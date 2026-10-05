/**
 * The shapes that flow through the whole app: one capture, one set of answers,
 * one scored record. Nothing here imports Electron or React — core/ is plain
 * TypeScript so the rules can be unit-tested without a window or a camera.
 */

import type { UnusableReason } from './usable'

/**
 * Vitals from a single SmartSpectra measurement, flattened from the SDK's
 * time-series into the summary values a check-in actually stores.
 *
 * The SDK returns each metric as a series of samples with per-sample
 * confidence (`cardio.pulseRate[]`, `cardio.hrv[]`, `breathing.rate[]`); the
 * capture layer reduces those to the values below. A metric the SDK never
 * reported with usable confidence stays `null` rather than defaulting to a
 * number — a missing reading and a reading of zero must not look alike to the
 * rules.
 */
export interface Vitals {
  /** Beats per minute. */
  pulseRateBpm: number | null
  /** Breaths per minute. */
  breathingRateBrpm: number | null
  /** HRV, root mean square of successive differences, in milliseconds. */
  hrvRmssdMs: number | null
  /** HRV, standard deviation of NN intervals, in milliseconds. */
  hrvSdnnMs: number | null
  /**
   * The SDK's own confidence in the readings being reported, 0..1 (KV-12).
   *
   * Per metric, averaged over the readings the SDK called settled — the same
   * ones the values above come from — falling back to that metric's every
   * reading when it settled on none; then averaged across the metrics that
   * reported a confidence at all. It says how far to trust the numbers beside
   * it, not what share of the capture was usable.
   *
   * **Null when nothing reported a confidence at all, which is not zero.** A
   * capture can produce a rate carrying no confidence and no stable flag —
   * a value and a timestamp and nothing else, seen in a real run. Reporting
   * that as `0` claimed the SDK had rated the reading and found it worthless.
   * A capture nothing vouched for has its verdict withheld rather than scored:
   * saying "we cannot tell you today" is truer than implying a number can be
   * trusted because nothing contradicted it.
   *
   * **The verdict is withheld; the reading is not.** The card still shows the
   * rate, because the reading is real and hiding a measurement the camera
   * actually took would be its own dishonesty — what must not happen is the
   * *comparison*, which is the part that would treat an unvouched-for number as
   * reliable. The sentence under the number says so outright.
   *
   * Records written before this carry a number and never null.
   */
  confidence: number | null
  /**
   * Whether the SDK marked the reading being reported as settled. The flag is
   * declared on the rate readings and on HRV alike, but in the KV-1 capture
   * only `cardio.pulseRate[]` and `breathing.rate[]` ever set it — HRV never
   * reported `stable: true`, which is an observation about that capture and
   * not a fact about the schema.
   */
  stable: boolean
  /** Seconds of usable capture. Short captures are not scored. */
  durationSec: number
}

/**
 * What the renderer gets back from a capture. The vitals are for display only:
 * `submit` takes the `captureId`, never the vitals, so the numbers that are
 * scored and stored can only be the ones the main process measured.
 */
export interface CaptureResult {
  captureId: string
  vitals: Vitals
}

export type MoodAnswer = 'good' | 'ok' | 'low'
export type SleepAnswer = 'well' | 'ok' | 'poorly'

/**
 * The meal question: exactly one of the two ever asked (KV-16). A union, not
 * two optional fields, so a check-in built with neither, or with both, does
 * not compile (review of #167). Each side names the other as `undefined` so a
 * reader can ask either field of any record without narrowing first.
 */
export type MealAnswer =
  | {
      /**
       * Whether they skipped a meal since the day before. Asked from KV-16 on,
       * and on every check-in written since.
       */
      skippedMeal: boolean
      eatenToday?: undefined
    }
  | {
      /**
       * "Have you eaten today?", as asked before KV-16, and only ever on a
       * record written then. Never written now: at 8am its "not yet" was an
       * ordinary morning, not a missed meal, and it weighed the same as one at
       * 4pm. A real check-in keeps it — "not yet" is not an answer to the new
       * question, and nobody's words are put into it. A seeded one is read as
       * the new question (`asAskedNow`), since it is generated data.
       */
      eatenToday: boolean
      skippedMeal?: undefined
    }

/** The four questions asked after the capture. Deliberately short. */
export type CheckInAnswers = {
  mood: MoodAnswer
  sleep: SleepAnswer
  painReported: boolean
  /** Free text, only collected when painReported is true. */
  painNote?: string
} & MealAnswer

/** One rule that fired, in the words the caregiver reads. */
export interface FiredRule {
  /** Stable identifier, e.g. `hrv-drop`. Used in tests and in the trend view. */
  id: string
  /** Short label, e.g. "HRV below usual". */
  title: string
  /** One plain-language sentence naming the actual numbers. */
  explanation: string
  /**
   * How much this contributes to the flag, 0..1. Severities sum; see
   * core/scoring for the threshold. Not a probability and not a risk score —
   * it exists only to order and combine rules.
   */
  severity: number
}

export type Flag =
  /** Nothing stood out against this person's own baseline. */
  | 'normal'
  /** At least one rule fired hard enough to be worth a caregiver's attention. */
  | 'elevated'
  /** Not enough usable signal, or not enough history, to say either way. */
  | 'insufficient-signal'

/** The metrics a rule compares against their usual. `hrvSdnnMs` is not one. */
export type ComparedMetric = 'pulse' | 'breathing' | 'hrv'

/**
 * A metric measured at this check-in that had no usual to compare it with
 * (KV-87): its own history was shorter than the scorer needs. The counts are
 * stored, not the sentence, so the wording can change without rescoring.
 */
export interface UncomparedMetric {
  metric: ComparedMetric
  /** Readings of this metric the baseline held. */
  readings: number
  /** Readings it needed — `MIN_BASELINE_SESSIONS` when this was scored. */
  needed: number
  /**
   * What those readings averaged, when there were any. Shown as evidence with
   * its weakness beside it — "those 2 averaged 82 bpm" — never as "their
   * usual", which is what KV-71 forbids a thin history to be called.
   */
  mean?: number
}

/** The stretch a baseline's window covered (KV-154). */
export interface BaselineSpan {
  /** When the oldest usable session in the window was captured. */
  from: string
  /**
   * When the newest one was — how fresh "their usual" is. Usable sessions in
   * the window only: not a refused capture, and not the session being scored.
   */
  to: string
}

export interface Assessment {
  flag: Flag
  /** Every rule that fired, highest severity first. Never summarised away. */
  firedRules: FiredRule[]
  /** One sentence for the top of the card. */
  summary: string
  /** How many past sessions the baseline was computed from. */
  baselineSessions: number
  /**
   * How many of those were seeded demo history rather than measured (KV-53).
   * Above zero, this verdict rests on invented numbers, and both the summary
   * and the card say so. Zero on a real install, which never seeds unless
   * someone asks it to.
   *
   * Optional because a session scored before KV-53 has no such field, and a
   * record that predates a field is not a record with a zero in it. Read it as
   * "unknown", not as "none": absent means nobody asked the question.
   */
  baselineSeededSessions?: number
  /**
   * Earlier check-ins the scorer refused as unusable: the refusals
   * `baselineSessions` excluded, not everything it leaves out, since it is
   * also capped at the window (KV-100). A card still learning says so, so a count
   * lower than the check-ins done is not left to inference. Absent on a
   * verdict scored before it existed, which reads as unknown: that card says
   * nothing about refusals rather than "none".
   */
  baselineRefusedSessions?: number
  /**
   * When the oldest and newest check-ins the baseline was built from were
   * captured (KV-154), so a card can say when its usual had gone stale.
   *
   * **Absent for two different reasons**, like `uncomparedMetrics`: with no
   * baseline sessions, where there is nothing to span and absence is correct,
   * and on a verdict scored before KV-154, where it means unknown. The first
   * only happens on a verdict that leans on no baseline — unusable, or too
   * early to compare — so read it as unknown only where the card compared
   * something. `present` relies on that when it recovers a missing span; a
   * test pins it.
   */
  baselineSpan?: BaselineSpan
  /**
   * Metrics measured at this check-in that could not be compared, because
   * their own history was too short (KV-87). Empty when every measured metric
   * was compared.
   *
   * Written only when the check-in was compared against a baseline at all —
   * not for an unusable capture, nor while the baseline is still learning,
   * where the summary already says nothing was compared. Absent on a verdict
   * scored before KV-87, and that reads as unknown, not as "none".
   */
  uncomparedMetrics?: UncomparedMetric[]
  /**
   * Why an `insufficient-signal` verdict was withheld (KV-138 review): the
   * capture could not be used, the baseline was still learning, or a measured
   * metric had no usual. Stored so the card's sentence is composed from a fact
   * rather than re-decided by today's predicates — which, asked again, can give
   * a different reason under the same flag, and a card would state a reason it
   * was never given.
   *
   * Absent on any other verdict, and on one scored before this existed; for
   * those the reason is recovered from the stored summary where it can be.
   */
  withheld?: WithheldReason
  /**
   * Which version of the rules gave this verdict: `RULES_VERSION` when it was
   * scored (KV-30). Absent on a verdict scored before versions were recorded,
   * and that reads as unknown, not as version 1: those were given by several
   * earlier scorers (KV-93, KV-100, KV-138 each changed what one stores), and
   * which one is not on the record.
   *
   * A seeded record's verdict is given when shown (KV-103), so it always
   * carries the current one.
   */
  rulesVersion?: number
}

/** What withheld a verdict: see `Assessment.withheld`. */
export type WithheldReason = UnusableReason | 'still-learning' | 'uncompared'

export interface SessionRecord {
  /**
   * The record format it was written in (KV-30): `RECORD_FORMAT` in
   * `core/session/format.ts`, which says when it changes. Absent on a record
   * written before KV-30, which is format 1 by definition and is read as that
   * (`formatOf`), never rewritten to say so.
   */
  format?: number
  id: string
  /** Which cared-for person this check-in belongs to. */
  personId: string
  /** ISO-8601 timestamp of the capture, in UTC. */
  capturedAt: string
  /**
   * IANA time zone of the device that recorded the capture, e.g.
   * `Europe/London` (KV-28). An IANA name, never a UTC offset: offsets change
   * with daylight saving and cannot be applied to another date.
   *
   * `capturedAt` alone cannot say which day a check-in belongs to for the
   * person who gave it — 23:30 in one zone is tomorrow in another — and a
   * caregiver reading from elsewhere needs *their* today, not the reader's.
   * That meaning cannot be recovered afterwards, so it is recorded at capture.
   *
   * Optional because a record written before this existed has no zone, and a
   * missing zone must not be guessed into a wrong one. Absent means unknown;
   * `localDateOf` answers null rather than inventing a day.
   */
  timeZone?: string
  vitals: Vitals
  answers: CheckInAnswers
  /** Written by the scorer; absent until the session has been scored. */
  assessment?: Assessment
  /**
   * True for the pre-seeded demo history (KV-8). The dashboard labels these
   * rather than hiding them — a demo persona's history is not real data and
   * the UI should not imply that it is.
   */
  seeded?: boolean
}

/**
 * What is kept of a deleted check-in (KV-21): which one, whose, and when — no
 * reading, no answer, no note. It is what stops an export made earlier, or a
 * copy arriving by sync (#45), bringing the check-in back. A seeded day leaves
 * none: it never leaves the device, and its id repeats across installs.
 */
export interface Tombstone {
  id: string
  personId: string
  /** When it was deleted, as `toISOString` writes it. */
  removedAt: string
}
