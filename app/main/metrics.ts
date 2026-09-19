import type { Vitals } from '@core/session/types'

/**
 * Reducing the SDK's sample stream to one `Vitals`.
 *
 * **Imports nothing from the SDK on purpose.** `@smartspectra/node-sdk` loads
 * its native runtime through koffi at import time, so a module that touches it
 * cannot be unit-tested on a machine without a runtime for that platform —
 * there is no darwin-x64 one at all. `vitals.ts` pins these shapes against the
 * SDK's own types at compile time so the decoupling cannot drift into a typo.
 *
 * **A decoded message is a protobufjs instance, not a plain object.** Proto3
 * defaults live on the prototype, so an unset `value` reads as `0` and an unset
 * `confidence` reads as `0` — never `undefined`. Presence is therefore decided
 * by own-property, never by the value itself. Missing is not zero, and here is
 * where a missing reading would otherwise become a measured zero.
 */

/** One reading of a rate metric: `cardio.pulseRate[]`, `breathing.rate[]`. */
export interface RateReading {
  value?: number | null
  /** The SDK's own confidence, as a percentage in [0, 100]. */
  confidence?: number | null
  /** Whether the SDK considered this reading settled. */
  stable?: boolean | null
  /** Microseconds since the epoch. Only used to avoid counting a reading twice. */
  timestamp?: unknown
}

/** One HRV entry. The schema carries `confidence` and `stable` here too. */
export interface HrvReading {
  rmssd?: number | null
  sdnn?: number | null
  meanNn?: number | null
  baevsky?: number | null
  confidence?: number | null
  stable?: boolean | null
  timestamp?: unknown
}

/** As much of a decoded metrics message as the reduction reads. */
export interface MetricsLike {
  cardio?: {
    pulseRate?: readonly RateReading[] | null
    hrv?: readonly HrvReading[] | null
  } | null
  breathing?: {
    rate?: readonly RateReading[] | null
    /** Waveform points, not a rate. Most of the stream is these; ignored here. */
    upperTrace?: readonly RateReading[] | null
  } | null
}

/**
 * The field's value, or undefined when the SDK did not set it.
 *
 * `reading.value ?? null` cannot do this job: the prototype default answers
 * first and a reading that reported nothing arrives as a confident zero.
 */
function set<T extends object, K extends keyof T>(reading: T, key: K): T[K] | undefined {
  return Object.hasOwn(reading, key as string) ? reading[key] : undefined
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

/**
 * Tracks one metric across the stream: the newest reading, the newest the SDK
 * marked stable, and the confidences this metric reported along the way.
 */
class Tracked<T extends object> {
  latest: T | undefined
  latestStable: T | undefined
  /** Timestamps already counted, so a repeated reading is not averaged twice. */
  private readonly counted = new Set<string>()
  /** This metric's confidences in [0, 1], split by the SDK's own verdict. */
  private readonly settled: number[] = []
  private readonly every: number[] = []

  observe(readings: readonly T[] | null | undefined): void {
    if (readings === null || readings === undefined) return

    for (const reading of readings) {
      // Every reading in the message counts toward the average, not just the
      // last: a message batching 40%, 45% and 95% must not read as 95%.
      const stamp = set(reading, 'timestamp' as keyof T)
      const key = stamp === undefined ? undefined : String(stamp)
      if (key !== undefined && this.counted.has(key)) continue
      if (key !== undefined) this.counted.add(key)

      const isStable = set(reading, 'stable' as keyof T) === true
      this.latest = reading
      if (isStable) this.latestStable = reading

      const confidence = set(reading, 'confidence' as keyof T)
      if (typeof confidence === 'number') {
        this.every.push(confidence / 100)
        if (isStable) this.settled.push(confidence / 100)
      }
    }
  }

  /**
   * The reading to report: the newest one the SDK called stable, falling back
   * to the newest of any kind. Someone shifting in their chair at the end of a
   * capture must not overwrite nine settled seconds with one outlier — and no
   * rule downstream consults `stable`, so this is where that verdict is used.
   */
  get chosen(): T | undefined {
    return this.latestStable ?? this.latest
  }

  /**
   * This metric's own confidence in [0, 1], or undefined when it never
   * reported one — which is not the same as a confidence of zero (KV-12).
   *
   * Averaged over the readings the SDK called settled, since `chosen` reports
   * one of those; falling back to every reading when it settled on none, which
   * is then what the reported value rests on.
   *
   * **Decided per metric, not once for the capture.** Pooling that decision
   * lets a metric that settled vouch for one that never did: the unsettled
   * readings drop out of the average while their value is still reported, so a
   * clean breathing rate would carry a distrusted pulse past
   * `MIN_CAPTURE_CONFIDENCE` and into a rule that quotes the pulse.
   */
  get confidence(): number | undefined {
    if (this.every.length === 0) return undefined
    // Not null here: this metric reported confidences, so one of the two lists
    // is non-empty. Null at this level would mean "unrated", which is the whole
    // point of the branch above.
    return averageOf(this.settled.length > 0 ? this.settled : this.every) ?? undefined
  }
}

export interface VitalsAccumulator {
  add(metrics: MetricsLike): void
  result(durationSec: number): Vitals
}

/**
 * Collects the sample stream into one `Vitals`.
 *
 * **A metrics message carries whichever metrics were ready at that instant,
 * not all of them.** Measured over a real 60s capture (KV-1): 1309 messages
 * carried breathing only, 118 cardio only, and 90 both. So each metric is kept
 * as it arrives rather than read off the final message — reading them all off
 * one message returns whatever that message happened to hold and silently
 * discards the rest, while `captureIsUsable` still calls the check-in usable.
 */
export function createVitalsAccumulator(): VitalsAccumulator {
  const pulse = new Tracked<RateReading>()
  const breathing = new Tracked<RateReading>()
  const hrv = new Tracked<HrvReading>()
  const tracked = [pulse, breathing, hrv]

  return {
    add(metrics) {
      // Confidence spans every metric that reports one. Pulse alone would make
      // this a pulse-presence check wearing a confidence threshold's clothes:
      // a capture with a clean breathing rate and no pulse would average zero
      // and be discarded as unusable (KV-12).
      pulse.observe(metrics.cardio?.pulseRate)
      breathing.observe(metrics.breathing?.rate)
      hrv.observe(metrics.cardio?.hrv)
    },

    result(durationSec) {
      const chosenPulse = pulse.chosen
      const chosenBreathing = breathing.chosen
      const chosenHrv = hrv.chosen

      return {
        pulseRateBpm: num(chosenPulse && set(chosenPulse, 'value')),
        breathingRateBrpm: num(chosenBreathing && set(chosenBreathing, 'value')),
        hrvRmssdMs: num(chosenHrv && set(chosenHrv, 'rmssd')),
        hrvSdnnMs: num(chosenHrv && set(chosenHrv, 'sdnn')),
        // Describes the readings actually being reported (KV-12).
        //
        // Each metric resolves its own confidence from its own readings (see
        // Tracked.confidence), and the capture averages the metrics that
        // reported one. Averaging every reading instead mixes in the ones the
        // SDK distrusted, and those are scattered through a capture rather
        // than clustered at its start: across recorded runs that pulled 0.64
        // down to 0.45, under MIN_CAPTURE_CONFIDENCE, and threw away captures
        // carrying a settled pulse and breathing rate.
        //
        // Metrics count once each, not once per reading, so the chattiest
        // metric does not decide the number: a real capture carried breathing
        // on 1399 messages and cardio on 208, and weighting by reading count
        // would let breathing all but speak for the pulse beside it.
        //
        // What it is not: a measure of how much of the capture was usable. A
        // metric that settled once after a noisy minute reports that settled
        // reading and its confidence, because that reading is what the card
        // shows. Whether a metric whose own confidence is poor should be
        // nulled instead of counted here is left open, because it changes when
        // rules fire.
        confidence: averageOf(definedConfidences(tracked)),
        // True when the reading being reported is one the SDK itself called
        // settled. Reported per capture; nothing gates on it yet (KV-12).
        stable: reportedStable(chosenPulse, chosenBreathing),
        durationSec,
      }
    },
  }
}

/**
 * Null when nothing rated the readings, rather than zero (KV-12).
 *
 * Zero said the SDK had judged these readings and found them worthless. It had
 * not judged them at all — a real capture carried a breathing rate with no
 * confidence and no stable flag on it, just a value and a timestamp.
 */
const averageOf = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length

/**
 * The confidence of every metric that reported one. A metric that reported
 * none contributes nothing rather than a zero — missing is not zero, and one
 * silent metric must not halve the capture's confidence.
 */
const definedConfidences = (tracked: readonly { confidence: number | undefined }[]): number[] =>
  tracked.map((t) => t.confidence).filter((c): c is number => c !== undefined)

/**
 * Pulse decides when it reported a flag, because every vitals rule leans on it
 * hardest; breathing answers only when pulse said nothing either way.
 */
function reportedStable(
  pulse: RateReading | undefined,
  breathing: RateReading | undefined,
): boolean {
  const fromPulse = pulse === undefined ? undefined : set(pulse, 'stable')
  if (typeof fromPulse === 'boolean') return fromPulse
  const fromBreathing = breathing === undefined ? undefined : set(breathing, 'stable')
  return fromBreathing === true
}
