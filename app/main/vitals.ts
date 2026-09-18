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
import { createVitalsAccumulator } from './metrics'

/**
 * The SmartSpectra capture, wrapped down to the one call the rest of the app
 * needs: run the camera for N seconds, hand back a single `Vitals`.
 *
 * STATUS (KV-1): the capture path has now returned real readings from a real
 * webcam — pulse, breathing and HRV, on one machine, in one room. What that run
 * corrected is recorded in `createVitalsAccumulator` and in ARCHITECTURE.md.
 * Still open in KV-1: the capture-length constants, and whether capture stays
 * here or moves to the renderer. There is deliberately no synthetic fallback:
 * without a key or a camera this throws, because a check-in that quietly
 * invented vitals would be worse than no check-in.
 *
 * OPEN DECISION (KV-1): this uses the main-process SDK with `useCamera()`, which
 * the SDK docs note "captures in THIS process" and for Electron suggests the
 * renderer SDK's `useMediaStream()` instead. The renderer path additionally
 * emits a `streamAvailable` MediaStream for a live self-view — valuable, since
 * bad framing and low light are the top demo risk — but it constructs the SDK
 * (and therefore the API key) in the renderer. Settle this on hardware.
 */

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
  // Both of these said the opposite until KV-1 put a face in front of the
  // camera: "too low" means the face sits low IN THE FRAME, so the camera has
  // to come down to meet it, not go up. The SDK's own hints agree.
  [ValidationCode.kFaceTooHigh]: 'Move down, or tilt the camera up.',
  [ValidationCode.kFaceTooLow]: 'Move up, or tilt the camera down.',
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
 * Reduction rules, and why: each metric keeps the last reading the SDK sent for
 * *that metric*, because a metrics message carries only what was ready at that
 * instant. Confidence is averaged across the whole capture rather than taken
 * from the final reading, so one good moment at the end cannot make a poor
 * capture look clean. See `createVitalsAccumulator`.
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

  const collected = createVitalsAccumulator()
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
      collected.add(decodeMetrics(buf))
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
      resolve(collected.result(Math.round((Date.now() - startedAt) / 1000)))
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
