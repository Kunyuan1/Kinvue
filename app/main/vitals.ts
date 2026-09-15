import {
  SmartSpectraSDK,
  breathingMetrics,
  cardioMetrics,
  ValidationCode,
  type ValidationCodeValue,
} from '@smartspectra/node-sdk'
// NOT the root `decodeMetrics`: that one returns the raw Buffer unless a
// protobuf class has been registered with setMetricsClass(). The `/messages`
// entry point ships the generated class and returns a typed Metrics.
import { decodeMetrics } from '@smartspectra/node-sdk/messages'
import type { Vitals } from '@core/session/types'

/**
 * The SmartSpectra capture, wrapped down to the one call the rest of the app
 * needs: run the camera for N seconds, hand back a single `Vitals`.
 *
 * STATUS (KV-1): written against the SDK's shipped type definitions but NOT yet
 * validated against a real webcam. That spike is the first ticket and nothing
 * downstream should be trusted end-to-end until it closes. There is deliberately
 * no synthetic fallback: without a key or a camera this throws, because a
 * check-in that quietly invented vitals would be worse than no check-in.
 *
 * OPEN DECISION (KV-1): this uses the main-process SDK with `useCamera()`, which
 * the SDK docs note "captures in THIS process" and for Electron suggests the
 * renderer SDK's `useMediaStream()` instead. The renderer path additionally
 * emits a `streamAvailable` MediaStream for a live self-view — valuable, since
 * bad framing and low light are the top demo risk — but it constructs the SDK
 * (and therefore the API key) in the renderer. Settle this on hardware.
 */

// Derived from the decoder's own return type rather than imported from
// `js/messages/generated`: that path is real on disk but absent from the
// package's exports map, so importing it directly does not resolve.
type Metrics = ReturnType<typeof decodeMetrics>
type Cardio = NonNullable<Metrics['cardio']>
type Hrv = NonNullable<Cardio['hrv']>[number]

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

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'SMARTSPECTRA_API_KEY is not set. Register free at ' +
        'https://physiology.presagetech.com/auth/register and put the key in .env',
    )
    this.name = 'MissingApiKeyError'
  }
}

/** What the person in front of the camera should do differently, in their words. */
const VALIDATION_HINTS: Partial<Record<ValidationCodeValue, string>> = {
  [ValidationCode.kNoFaceFound]: 'No face in view — sit in front of the camera.',
  [ValidationCode.kMultipleFacesFound]: 'More than one face in view.',
  [ValidationCode.kFaceNotCentered]: 'Move to the centre of the picture.',
  [ValidationCode.kTooDark]: 'Too dark — turn on a light or face a window.',
  [ValidationCode.kTooBright]: 'Too bright — move away from the light behind you.',
  [ValidationCode.kChestNotVisible]: 'Sit back a little so your chest is in view.',
  [ValidationCode.kFaceTooClose]: 'Sit back a little.',
  [ValidationCode.kFaceTooFar]: 'Come a little closer.',
  [ValidationCode.kFaceTooHigh]: 'Lower the camera, or sit up straighter.',
  [ValidationCode.kFaceTooLow]: 'Raise the camera a little.',
  [ValidationCode.kFaceNotForward]: 'Look straight at the camera.',
  [ValidationCode.kExcessiveMotion]: 'Try to hold still.',
  [ValidationCode.kFrameRateTooLow]: 'The camera is struggling to keep up.',
}

export interface CaptureOptions {
  /** How long to hold the camera open. The UI asks the person for ~30s. */
  durationSec?: number
  /** Called with elapsed seconds so the renderer can show a countdown. */
  onProgress?: (elapsedSec: number) => void
  /**
   * Called when the SDK reports the shot is unusable — bad framing, low light,
   * too much movement. Surfacing this live is the difference between a capture
   * that fails and a person who can fix it while it is still running.
   */
  onGuidance?: (message: string) => void
}

/**
 * Run one measurement and reduce the SDK's sample stream to summary values.
 *
 * Reduction rules, and why: pulse and breathing take the LAST sample, which is
 * the SDK's most settled estimate. HRV takes the last sample the SDK itself
 * marked `stable`, falling back to the last sample of any kind. Confidence is
 * averaged across the whole capture rather than taken from the final sample, so
 * one good frame at the end cannot make a poor capture look clean.
 */
export async function captureVitals(options: CaptureOptions = {}): Promise<Vitals> {
  const { durationSec = 30, onProgress, onGuidance } = options

  const apiKey = process.env.SMARTSPECTRA_API_KEY
  if (apiKey === undefined || apiKey === '') throw new MissingApiKeyError()

  const sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: [...breathingMetrics, ...cardioMetrics],
    // Opt out of SDK telemetry, which defaults to on. The README promises this
    // app makes no network calls of its own; leaving an aggregate telemetry
    // channel open would make that claim untrue.
    enableTelemetry: false,
  })

  const confidences: number[] = []
  let latest: Metrics | undefined
  let lastStableHrv: Hrv | undefined

  const startedAt = Date.now()

  return await new Promise<Vitals>((resolve, reject) => {
    const cleanUp = (): void => {
      clearInterval(ticker)
      clearTimeout(timer)
      void sdk
        .stopAsync()
        .then(async () => await sdk.destroy())
        .catch(() => undefined)
    }

    const ticker = setInterval(() => {
      onProgress?.(Math.round((Date.now() - startedAt) / 1000))
    }, 1000)

    // NOTE: `on()` REPLACES the callback for an event rather than adding one,
    // so there is exactly one registration per event here. Do not add a second.
    sdk.on('metrics', (buf: Buffer) => {
      const decoded = decodeMetrics(buf)
      latest = decoded

      const hrv = last(decoded.cardio?.hrv)
      if (hrv !== undefined) {
        if (hrv.stable === true) lastStableHrv = hrv
        const c = toUnitConfidence(hrv.confidence)
        if (c !== null) confidences.push(c)
      }

      const pulse = last(decoded.cardio?.pulseRate)
      const pulseConfidence = toUnitConfidence(pulse?.confidence)
      if (pulseConfidence !== null) confidences.push(pulseConfidence)
    })

    sdk.on('validationStatus', (code: ValidationCodeValue, _ts: number, hint: string) => {
      if (code === ValidationCode.kOk) return
      onGuidance?.(VALIDATION_HINTS[code] ?? hint)
    })

    sdk.on('error', (_code: number, message: string) => {
      cleanUp()
      reject(new Error(`SmartSpectra: ${message}`))
    })

    const timer = setTimeout(() => {
      cleanUp()

      const hrv = lastStableHrv ?? last(latest?.cardio?.hrv)
      resolve({
        pulseRateBpm: last(latest?.cardio?.pulseRate)?.value ?? null,
        breathingRateBrpm: last(latest?.breathing?.rate)?.value ?? null,
        hrvRmssdMs: hrv?.rmssd ?? null,
        hrvSdnnMs: hrv?.sdnn ?? null,
        confidence: mean(confidences),
        stable: lastStableHrv !== undefined,
        durationSec: Math.round((Date.now() - startedAt) / 1000),
      })
    }, durationSec * 1000)

    try {
      sdk.useCamera()
      sdk.start()
    } catch (err) {
      cleanUp()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
