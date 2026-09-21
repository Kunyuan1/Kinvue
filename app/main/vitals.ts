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
import { DEFAULT_CAPTURE_SECONDS } from '@core/capture/length'
import { askedForCaptureLog, awaitRelease, releaseLogLine, teardown } from './release'
import { SETTLE_AFTER_COMPLETE_SECONDS } from '@core/capture/length'
import {
  CaptureCancelledError,
  MissingApiKeyError,
  captureError,
  sdkErrorCode,
  sdkFailure,
} from './capture-errors'
import type { CaptureGuidance } from '@core/capture/guidance'
import type { SdkFrame } from './frames'
import type { Vitals } from '@core/session/types'
import {
  createVitalsAccumulator,
  type HrvReading,
  type MetricsLike,
  type RateReading,
} from './metrics'

/**
 * The SmartSpectra capture, wrapped down to the one call the rest of the app
 * needs: run the camera for N seconds, hand back a single `Vitals`.
 *
 * STATUS (KV-1): the capture path has now returned real readings from a real
 * webcam — pulse, breathing and HRV, on one machine, in one room. What that run
 * corrected is recorded in `metrics.ts` and in ARCHITECTURE.md.
 * Still open in KV-1: the capture-length constants, and whether capture stays
 * here or moves to the renderer. There is deliberately no synthetic fallback:
 * without a key or a camera this throws, because a check-in that quietly
 * invented vitals would be worse than no check-in.
 *
 * SETTLED (KV-1): capture stays here, in main, with `useCamera()`. The renderer
 * SDK's `useMediaStream()` would have bought a live self-view — which real
 * captures showed is not optional, since framing the person cannot see is the
 * main way a capture returns nothing — but it constructs the SDK, and therefore
 * the API key, in the renderer. It is not needed: the `videoOutput` event
 * carries processed frames from this process, so the self-view can be fed over
 * IPC instead (#3). See ARCHITECTURE.md.
 */


/**
 * `metrics.ts` describes the decoded message structurally so it can be tested
 * without loading the native runtime. These assertions are the tether: if a
 * field name there stops matching the SDK — a typo, or a rename in a future
 * version — this stops compiling instead of quietly reducing every capture to
 * nulls, which is the failure KV-1 was opened to fix.
 */
type Metrics = ReturnType<typeof decodeMetrics>
type Assert<T extends true> = T
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false

type Keys<T> = keyof NonNullable<T>
type Entry<T> = NonNullable<T> extends readonly (infer E)[] ? E : never

type SdkCardio = NonNullable<Metrics['cardio']>
type SdkBreathing = NonNullable<Metrics['breathing']>

/**
 * Exported so it is not an unused local; it exists only to be checked.
 *
 * Each line says "every field name metrics.ts reads is a field the SDK has".
 * Asserting the other direction would not work: an extra optional property
 * never breaks assignability, so a typo would typecheck happily and reduce
 * every capture to nulls.
 */
export type SdkShapePinned = [
  Assert<Metrics extends MetricsLike ? true : false>,
  Assert<Keys<MetricsLike['cardio']> extends Keys<Metrics['cardio']> ? true : false>,
  Assert<Keys<MetricsLike['breathing']> extends Keys<Metrics['breathing']> ? true : false>,
  Assert<HasKey<SdkCardio, 'pulseRate'>>,
  Assert<HasKey<SdkCardio, 'hrv'>>,
  Assert<HasKey<SdkBreathing, 'rate'>>,
  // Field names on the readings themselves.
  Assert<keyof RateReading extends keyof Entry<SdkCardio['pulseRate']> ? true : false>,
  Assert<keyof RateReading extends keyof Entry<SdkBreathing['rate']> ? true : false>,
  Assert<keyof HrvReading extends keyof Entry<SdkCardio['hrv']> ? true : false>,
]

// Both live in `capture-errors.ts`, which the SDK-free suite can import.
export { CaptureCancelledError, MissingApiKeyError }

/**
 * What the person in front of the camera should do differently, in their words.
 *
 * Every code except `kOk` is covered on purpose, and the type enforces it: the
 * SDK's own `hint` strings are never forwarded. Two entries in this table told
 * people to move the camera the wrong way until KV-1 put a face in front of
 * one, and vendor copy nobody has read is not a safe default on the single
 * surface the cared-for person reads.
 */
type Advisable = Exclude<ValidationCodeValue, typeof ValidationCode.kOk>

const VALIDATION_HINTS: Record<Advisable, string> = {
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
  [ValidationCode.kCameraTuning]: 'Just a moment — the camera is adjusting.',
  // Deprecated in favour of kFaceTooClose / kFaceTooFar, which say which way.
  [ValidationCode.kFaceSizeOutOfRange]: 'Move a little closer, or a little further back.',
}

/**
 * Codes a camera produces while settling rather than because of the person.
 * The measured burst was `kTooDark`; the others sit alongside it as properties
 * of exposure and tuning. Framing codes are deliberately not here — nobody is
 * out of frame by accident of warm-up. See `core/capture/guidance.ts`.
 */
const SETTLING_CODES: ReadonlySet<ValidationCodeValue> = new Set([
  ValidationCode.kTooDark,
  ValidationCode.kTooBright,
  ValidationCode.kCameraTuning,
])

export interface CaptureOptions {
  /** How long to hold the camera open. The UI asks the person for ~30s. */
  durationSec?: number
  /** Called with elapsed seconds so the renderer can show a countdown. */
  onProgress?: (elapsedSec: number) => void
  /**
   * Called when the SDK reports the shot is unusable — bad framing, low light,
   * too much movement — and with null when it reports the shot is fine.
   * Surfacing this live is the difference between a capture that fails and a
   * person who can fix it while it is still running. What reaches a screen is
   * decided by `core/capture/guidance.ts`, not here.
   */
  onGuidance?: (advice: CaptureGuidance | null) => void
  /**
   * Each processed frame, for the person's own self-view (KV-3). The SDK docs
   * call `videoOutput` "mainly useful for the custom-input / headless path",
   * but it fires under `useCamera()` — confirmed against real hardware in KV-1,
   * which is what let the capture stay in the main process with the API key.
   *
   * Display only. Nothing here writes footage anywhere.
   */
  onFrame?: (frame: SdkFrame) => void
  /**
   * Abandons the capture and releases the camera (KV-3). The person in front
   * of it is the one who decides when being filmed stops, so a screen that
   * offers to stop has to actually stop — and until this existed, the camera
   * ran on for up to thirty more seconds with nothing watching.
   */
  signal?: AbortSignal
}

/**
 * Run one measurement and reduce the SDK's sample stream to summary values.
 *
 * Reduction rules, and why: each metric keeps the newest reading the SDK marked
 * stable — falling back to the newest of any kind — because a metrics message
 * carries only what was ready at that instant, and the last thing to arrive can
 * be an outlier the SDK itself distrusted. Confidence comes from the readings
 * being reported rather than from the whole capture (#70): per metric, averaged
 * over the ones the SDK called settled, then averaged across the metrics that
 * rated anything — and `null`, not `0`, when none of them did (KV-12), because
 * a rating nobody gave is not a rating of worthless. See
 * `createVitalsAccumulator`.
 */
export async function captureVitals(options: CaptureOptions = {}): Promise<Vitals> {
  const { durationSec = DEFAULT_CAPTURE_SECONDS, onProgress, onGuidance, onFrame, signal } = options
  if (signal?.aborted === true) throw new CaptureCancelledError()

  const apiKey = process.env.SMARTSPECTRA_API_KEY
  if (apiKey === undefined || apiKey === '') throw new MissingApiKeyError()

  const sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: [...breathingMetrics, ...cardioMetrics],
    // Opt out of SDK telemetry, which defaults to on. It does not make the app
    // offline — the SDK still contacts Presage when a session starts (KV-65) —
    // but an aggregate telemetry channel is a separate thing to decline.
    enableTelemetry: false,
  })

  const collected = createVitalsAccumulator()
  const startedAt = Date.now()
  // Seconds of *capture*, which is what Vitals.durationSec claims and what
  // MIN_CAPTURE_SECONDS is compared against. Opening the camera can take
  // several seconds, and those come straight out of the window a reading has
  // to appear in — counting them would report a short capture as a full one.
  let firstFrameAt: number | undefined

  // The teardown this capture started, so the capture can wait for it before
  // it settles (KV-84). Until then the *lock* cleared the moment the promise
  // did while the *device* closed whenever `stopAsync` and `destroy` happened
  // to finish — so `capture-in-progress` meant "the lock is still held", and
  // a person told a new reading could start could be told instead that another
  // program had the camera. Holding the lock until the device is down makes
  // that sentence mean what it says.
  let releasing: Promise<unknown> | undefined
  // When the teardown began, so the figure #63 acts on measures the teardown
  // rather than the gap between settling and asking about it. The same tick on
  // every path today, which makes it correct by coincidence rather than by
  // construction.
  let releaseStartedAt = 0
  // Whether the SDK ever opened the camera. `useCamera()` only selects an
  // input — the typing says the device is opened on `start()` — so a throw
  // from `start()` leaves nothing of ours holding it.
  let opened = false

  return await new Promise<Vitals>((resolve, reject) => {
    const cleanUp = (): void => {
      clearInterval(ticker)
      clearTimeout(timer)
      // Once only. Five call sites settle this promise and the SDK can raise an
      // error after one of them has; a second `stopAsync()` on a device already
      // closing is not something to find out about in the field.
      if (releasing !== undefined) return
      releaseStartedAt = Date.now()
      releasing = teardown(sdk)
    }

    /** Ends the capture with whatever has been collected. */
    const finish = (): void => {
      cleanUp()
      const capturedMs = firstFrameAt === undefined ? 0 : Date.now() - firstFrameAt
      resolve(collected.result(Math.round(capturedMs / 1000)))
    }

    // When every scorable metric had arrived, or undefined while one is still
    // missing. The capture runs on for a settle margin after this rather than
    // stopping on the instant, because the metric that completes the set is
    // the slowest one and its first reading is its noisiest.
    let completeAt: number | undefined

    const ticker = setInterval(() => {
      onProgress?.(Math.round((Date.now() - startedAt) / 1000))

      // Asked on the clock that was already running, so nothing new polls.
      if (completeAt === undefined) {
        if (collected.hasEveryMetric()) completeAt = Date.now()
        return
      }
      if (Date.now() - completeAt >= SETTLE_AFTER_COMPLETE_SECONDS * 1000) finish()
    }, 1000)

    // NOTE: `on()` REPLACES the callback for an event rather than adding one,
    // so there is exactly one registration per event here. Do not add a second.
    sdk.on('metrics', (buf: Buffer) => {
      firstFrameAt ??= Date.now()
      try {
        collected.add(decodeMetrics(buf))
      } catch (err) {
        // Thrown inside an SDK callback, so nothing here would catch it and
        // the capture would resolve as if the lost samples never existed.
        cleanUp()
        reject(captureError('camera-unavailable', 'could not decode metrics.', err))
      }
    })

    sdk.on('validationStatus', (code: ValidationCodeValue, _ts: number) => {
      firstFrameAt ??= Date.now()
      if (code === ValidationCode.kOk) {
        onGuidance?.(null)
        return
      }
      onGuidance?.({
        message: VALIDATION_HINTS[code as Advisable],
        settlingArtefact: SETTLING_CODES.has(code),
      })
    })

    // NOTE: one registration per event — `on()` replaces rather than adds.
    // Registered whether or not anyone wants the frames: it is what marks the
    // first frame, and a capture must not measure its own length differently
    // because the screen asked for a picture.
    sdk.on(
      'videoOutput',
      (data: Buffer, width: number, height: number, stride: number, pixelFormat: number) => {
        firstFrameAt ??= Date.now()
        // Best-effort, like progress and guidance: a preview that throws must
        // not take down the measurement it is showing.
        try {
          onFrame?.({ data, width, height, stride, pixelFormat })
        } catch {
          /* the reading matters more than the picture of it */
        }
      },
    )

    signal?.addEventListener(
      'abort',
      () => {
        cleanUp()
        reject(new CaptureCancelledError())
      },
      { once: true },
    )

    sdk.on('error', (code: number, message: string) => {
      cleanUp()
      // Not all of the SDK's failures are the camera's. A key that is present
      // but rejected, expired or out of credit surfaces here, and calling that
      // a busy camera sends the person to close a video call that was never
      // the problem. `sdkFailure` keeps the two apart (KV-7).
      reject(captureError(sdkFailure(code), `SmartSpectra — ${message}`))
    })

    // The ceiling. Reaching it means something never arrived, and the capture
    // is scored on what did — which is the behaviour a fixed clock had for
    // every capture, now reserved for the ones that need it.
    const timer = setTimeout(finish, durationSec * 1000)

    try {
      sdk.useCamera()
      sdk.start()
      opened = true
    } catch (err) {
      cleanUp()
      // Opening the camera is where "another application is using it" lands —
      // but a rejected key throws from `start()` too, so the code decides
      // which it was rather than the call site assuming. The original error
      // rides along as `cause`: the tag must be in the message to cross IPC,
      // the class and stack need not be lost to a log on this side.
      const code = sdkErrorCode(err)
      const failure = code === undefined ? 'camera-unavailable' : sdkFailure(code)
      reject(captureError(failure, 'the camera could not be started.', err))
    }
  }).finally(async () => {
    // `finally` waits for a promise the callback returns, so the capture does
    // not settle — and `checkIn.capture` does not drop its lock — until the
    // camera is actually free or the wait has run out. Bounded, because a
    // teardown that hangs would otherwise become a lock nobody can clear.
    //
    // The outcome is deliberately not thrown: a capture that produced a good
    // reading must not become an error because the camera took an odd route to
    // closing, and one that already failed has its own reason to report.
    // Nothing consumes the outcome yet — `app/main` has no logger — but it is
    // returned rather than swallowed, which is what `.catch(() => undefined)`
    // was doing before.
    if (releasing === undefined) return
    if (!opened) {
      // `start()` threw, so the camera was never ours to release — and this is
      // the likeliest failure the app has. Waiting up to the whole bound before
      // "The camera could not be used" reaches the screen would make the common
      // case the slow one. The teardown still runs, unobserved, as it did
      // before any of this.
      void releasing.catch(() => undefined)
      return
    }
    const outcome = await awaitRelease(releasing)
    const line = releaseLogLine(
      outcome,
      Date.now() - releaseStartedAt,
      askedForCaptureLog(process.env),
      signal?.aborted === true,
    )
    // The only place app/main prints anything. `KINVUE_LOG_CAPTURE=1 npm run
    // dev` is how the number behind DEVICE_RELEASE_TIMEOUT_MS gets measured on
    // real hardware, which is what #63 needs and nobody could see before.
    if (line !== null) console.warn(line)
  })
}
