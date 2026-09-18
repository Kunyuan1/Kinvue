import type { Vitals } from '@core/session/types'

/**
 * Reducing the SDK's sample stream to one `Vitals`.
 *
 * **Imports nothing from the SDK on purpose.** `@smartspectra/node-sdk` loads
 * its native runtime through koffi at import time, so a module that touches it
 * cannot be unit-tested on a machine without a runtime for that platform —
 * there is no darwin-x64 one at all. The shapes below are structural, and the
 * decoded protobuf satisfies them.
 */

/** One reading of a rate metric: `cardio.pulseRate[]`, `breathing.rate[]`. */
export interface RateReading {
  value?: number | null
  /** The SDK's own confidence, as a percentage in [0, 100]. */
  confidence?: number | null
  /** Whether the SDK considered this reading settled. */
  stable?: boolean | null
  /**
   * Unread here — `capturedAt` is the app's own clock. Typed `unknown` because
   * the generated type says `number | Long` while the decoded wire data carries
   * strings; nothing in the app depends on which, so nothing here asserts it.
   */
  timestamp?: unknown
}

/** One HRV entry. Carries no confidence and no stable flag (KV-1). */
export interface HrvReading {
  rmssd?: number | null
  sdnn?: number | null
  meanNn?: number | null
  baevsky?: number | null
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

const last = <T,>(xs: readonly T[] | null | undefined): T | undefined =>
  xs === null || xs === undefined || xs.length === 0 ? undefined : xs[xs.length - 1]

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length

/**
 * The SDK reports confidence as a percentage in [0, 100]; everything in core/
 * works in [0, 1]. Convert once, here, at the boundary.
 */
const toUnitConfidence = (percent: number | null | undefined): number | null =>
  percent === null || percent === undefined ? null : percent / 100

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
 * discards the rest. In that capture it would have discarded the measured
 * pulse and breathing rate and kept the HRV alone — while `captureIsUsable`
 * still called the check-in usable, so the loss would not have shown up.
 */
export function createVitalsAccumulator(): VitalsAccumulator {
  let pulse: RateReading | undefined
  let breathing: RateReading | undefined
  let hrv: HrvReading | undefined
  const confidences: number[] = []

  return {
    add(metrics) {
      const nextPulse = last(metrics.cardio?.pulseRate)
      if (nextPulse !== undefined) {
        pulse = nextPulse
        const c = toUnitConfidence(nextPulse.confidence)
        if (c !== null) confidences.push(c)
      }

      const nextBreathing = last(metrics.breathing?.rate)
      if (nextBreathing !== undefined) breathing = nextBreathing

      const nextHrv = last(metrics.cardio?.hrv)
      if (nextHrv !== undefined) hrv = nextHrv
    },

    result(durationSec) {
      return {
        pulseRateBpm: pulse?.value ?? null,
        breathingRateBrpm: breathing?.value ?? null,
        hrvRmssdMs: hrv?.rmssd ?? null,
        hrvSdnnMs: hrv?.sdnn ?? null,
        // Pulse confidence only, which is what this has always averaged in
        // practice. Breathing carries its own and is the less settled signal —
        // in the KV-1 capture roughly half the breathing readings were marked
        // unstable against none of the pulse readings. Whether breathing
        // belongs in this average is KV-12.
        confidence: mean(confidences),
        // The settled flag lives on the per-metric readings, not on HRV.
        // Pulse is the one every scored vitals rule leans on, so it decides.
        stable: (pulse ?? breathing)?.stable === true,
        durationSec,
      }
    },
  }
}
