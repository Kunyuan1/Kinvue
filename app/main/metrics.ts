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
  /** The same two, counting only readings that carried a confidence of their own (KV-79). */
  private latestRated: T | undefined
  private latestStableRated: T | undefined
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
        this.latestRated = reading
        if (isStable) {
          this.settled.push(confidence / 100)
          this.latestStableRated = reading
        }
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
   * `chosen`, drawn only from readings that carried a confidence of their own:
   * what to report once something in the capture was rated (KV-79).
   *
   * Asked of the reading, not of the metric. A metric that rated one reading
   * and then sent a bare one would otherwise report the bare value under the
   * other reading's confidence — breathing rated 0.55 at 12, then a bare 30,
   * reported 30. Drawn this way it pairs exactly with `confidence` below:
   * `settled` is non-empty precisely when there is a stable rated reading, so
   * the number describes the reading actually reported.
   */
  get chosenRated(): T | undefined {
    return this.latestStableRated ?? this.latestRated
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
  /**
   * Whether every metric a rule can read has produced at least one reading.
   *
   * What a capture is actually waiting for. Duration was only ever a proxy for
   * this: the KV-1 run put breathing at ~13s, pulse at ~20s and HRV at ~34s,
   * so a fixed clock either cuts off the slow run or charges the fast one for
   * it. Asked directly, the capture can stop when it has what it came for.
   *
   * `hrvSdnnMs` is deliberately not in the list, for the same reason
   * `hasScorableVitals` leaves it out: nothing scores on it, so waiting for it
   * would be waiting for something no rule will read.
   */
  hasEveryMetric(): boolean
}

/**
 * Collects the sample stream into one `Vitals`.
 *
 * **A metrics message carries whichever metrics were ready at that instant,
 * not all of them.** Measured over a real 60s capture (KV-1): 1309 messages
 * carried breathing only, 118 cardio only, and 90 both. So each metric is kept
 * as it arrives rather than read off the final message — reading them all off
 * one message returns whatever that message happened to hold and silently
 * discards the rest, while `unusableReason` still finds no reason to withhold.
 */
export function createVitalsAccumulator(): VitalsAccumulator {
  const pulse = new Tracked<RateReading>()
  const breathing = new Tracked<RateReading>()
  const hrv = new Tracked<HrvReading>()
  // The metrics whose ratings count, both to vouch and to be vouched for.
  // HRV is in neither role (KV-79): see `result`.
  const rates = [pulse, breathing]

  return {
    add(metrics) {
      // Confidence spans both rates, whichever reported one. Pulse alone would make
      // this a pulse-presence check wearing a confidence threshold's clothes:
      // a capture with a clean breathing rate and no pulse would average zero
      // and be discarded as unusable (KV-12).
      pulse.observe(metrics.cardio?.pulseRate)
      breathing.observe(metrics.breathing?.rate)
      hrv.observe(metrics.cardio?.hrv)
    },

    hasEveryMetric() {
      // Asked *through* `result`, not alongside it. A separate presence test
      // drifted from the one that decides the reported value: `chosen` is set
      // by `Tracked.observe` for any entry that arrives, while `result` reads
      // the field with `Object.hasOwn` — so an HRV entry carrying `sdnn` and
      // no own `rmssd`, which is what proto3 sends when rmssd is zero, made
      // this true while `hrvRmssdMs` came back null. The capture then stopped
      // believing HRV had arrived, the card showed nothing for it, and
      // `hrv-drop` could not fire: the failure this predicate exists to end,
      // reached faster and with the capture asserting it had not happened.
      //
      // Deriving it means the two cannot disagree. The duration is irrelevant
      // to presence, so it is passed as zero.
      const { pulseRateBpm, breathingRateBrpm, hrvRmssdMs } = this.result(0)
      return pulseRateBpm !== null && breathingRateBrpm !== null && hrvRmssdMs !== null
    },

    result(durationSec) {
      // A rated metric must not vouch for an unrated one (KV-79). Once any
      // metric in the capture reported a confidence, the capture is going to be
      // scored on it — so a pulse or breathing rate that reported none of its
      // own is dropped here, before any rule can quote it, rather than riding
      // along on the other metric's number.
      //
      // Only then. When *nothing* was rated, KV-12's rule stands: the verdict
      // is withheld as `unrated` and the reading is still shown, because it is
      // real. Dropping it there too would turn "the camera did not say how
      // reliable this reading was" into "no reading came out of it", which is
      // false.
      //
      // Asked of the reading reported, not of the metric: once anything is
      // rated, each rate reports its newest *rated* reading, or nothing. A
      // metric that rated one reading must not lend that rating to a bare one
      // that came after it (see `Tracked.chosenRated`).
      //
      // Pulse and breathing only, in both directions. Those two series rate
      // themselves on this hardware, so an unrated one is a gap in the
      // reading. Whether HRV ever carries a confidence has not been observed,
      // so HRV neither vouches nor is vouched for: it is never dropped, which
      // would remove `hrv-drop` on no evidence, and its rating neither decides
      // whether the rates are dropped nor counts in `confidence` below — else a
      // rated HRV would delete a real pulse and breathing rate, or carry them
      // into a rule on its number. That half of #79 waits for HRV readings to
      // inspect, and whichever way it goes is a change to `rates`.
      const anyRated = rates.some((t) => t.confidence !== undefined)
      const reported = (t: Tracked<RateReading>): RateReading | undefined =>
        anyRated ? t.chosenRated : t.chosen
      const chosenPulse = reported(pulse)
      const chosenBreathing = reported(breathing)
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
        // shows.
        //
        // The *absent* half of per-metric confidence is decided above (KV-79):
        // an unrated pulse or breathing reading is not reported beside a rated
        // one, so it can no longer ride on that reading's number here. The
        // *poor* half — whether a metric whose own confidence is low should be
        // dropped too — is a threshold judgement and is still open; it belongs
        // with `MIN_CAPTURE_CONFIDENCE`, not here. HRV's confidence is left out
        // for the reason given above.
        confidence: averageOf(definedConfidences(rates)),
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
