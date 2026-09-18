import { describe, expect, it } from 'vitest'
import { createVitalsAccumulator, type MetricsLike } from '../app/main/metrics'

/**
 * `app/main/metrics.ts` is the reduction, split out of `vitals.ts` so it can be
 * tested here in the same no-camera, no-Electron suite as core/: importing the
 * SDK itself would load its native runtime, which is not available on every
 * platform a contributor might use.
 *
 * The shapes below mirror what a real capture emitted (KV-1): a metrics
 * message carries whichever metrics were ready at that instant, `stable` and
 * `confidence` sit on the per-metric readings, and HRV entries carry neither.
 * The values are invented — a real person's readings are not test data.
 */

const at = (us: number): string => String(us)

const breathingMsg = (value: number, confidence = 70, stable = true): MetricsLike =>
  ({ breathing: { rate: [{ value, confidence, stable, timestamp: at(1) }] } })

const pulseMsg = (value: number, confidence = 90, stable = true): MetricsLike =>
  ({ cardio: { pulseRate: [{ value, confidence, stable, timestamp: at(2) }] } })

const hrvMsg = (rmssd: number, sdnn: number): MetricsLike =>
  ({
    cardio: { hrv: [{ rmssd, sdnn, meanNn: 600, baevsky: 2.5, timestamp: at(3) }] },
  })

/** A trace-only message, which is most of what the stream actually carries. */
const traceMsg = (): MetricsLike =>
  ({ breathing: { upperTrace: [{ value: -0.47, stable: true, timestamp: at(4) }] } })

describe('createVitalsAccumulator', () => {
  it('keeps each metric from the message that carried it', () => {
    // The failure this exists to prevent: reading every metric off the final
    // message returns whatever that one happened to hold.
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(64))
    acc.add(breathingMsg(14))
    acc.add(hrvMsg(41, 52))
    acc.add(traceMsg())

    expect(acc.result(60)).toEqual({
      pulseRateBpm: 64,
      breathingRateBrpm: 14,
      hrvRmssdMs: 41,
      hrvSdnnMs: 52,
      confidence: 0.9,
      stable: true,
      durationSec: 60,
    })
  })

  it('keeps the latest reading of each metric, not the first', () => {
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(61))
    acc.add(pulseMsg(67))
    acc.add(hrvMsg(44, 55))
    acc.add(hrvMsg(39, 50))
    const result = acc.result(45)

    expect(result.pulseRateBpm).toBe(67)
    expect(result.hrvRmssdMs).toBe(39)
  })

  it('leaves a metric the SDK never reported as null, not zero', () => {
    const acc = createVitalsAccumulator()
    acc.add(breathingMsg(13))
    const result = acc.result(30)

    expect(result.breathingRateBrpm).toBe(13)
    expect(result.pulseRateBpm).toBeNull()
    expect(result.hrvRmssdMs).toBeNull()
    expect(result.hrvSdnnMs).toBeNull()
  })

  it('reports nothing measured as all null with zero confidence', () => {
    const result = createVitalsAccumulator().result(30)

    expect(result.pulseRateBpm).toBeNull()
    expect(result.breathingRateBrpm).toBeNull()
    expect(result.confidence).toBe(0)
    expect(result.stable).toBe(false)
  })

  it('averages pulse confidence across the capture, converted to 0..1', () => {
    // One good moment at the end must not make a poor capture look clean.
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(62, 40))
    acc.add(pulseMsg(63, 60))
    acc.add(pulseMsg(64, 98))

    expect(acc.result(30).confidence).toBeCloseTo(0.66, 5)
  })

  it('takes stable from the pulse reading, since HRV carries no such flag', () => {
    const acc = createVitalsAccumulator()
    acc.add(pulseMsg(64, 90, false))
    acc.add(hrvMsg(41, 52))

    expect(acc.result(30).stable).toBe(false)
  })

  it('falls back to breathing for stable when no pulse was reported', () => {
    const acc = createVitalsAccumulator()
    acc.add(breathingMsg(14, 70, true))

    expect(acc.result(30).stable).toBe(true)
  })

  it('ignores trace samples, which are not rates', () => {
    const acc = createVitalsAccumulator()
    acc.add(traceMsg())

    expect(acc.result(30).breathingRateBrpm).toBeNull()
  })
})
