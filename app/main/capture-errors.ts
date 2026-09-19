import { failureTag, type CaptureFailure, type TaggedFailure } from '@core/capture/failure'

/**
 * The errors the capture throws, and what the SDK's own error codes mean.
 *
 * Split out of `vitals.ts` for the same reason `metrics.ts` was: importing
 * `@smartspectra/node-sdk` loads the native runtime through koffi at import
 * time, so anything in `vitals.ts` is untestable on a machine without one.
 * Nothing here imports the SDK, so the tags these errors carry — the contract
 * the screens read — can be pinned in the ordinary no-camera suite.
 *
 * The numbers below are `SmartSpectraErrorCode` from the SDK's typings,
 * repeated rather than imported for exactly that reason. They are a stable
 * published enum; the test asserts the ones we map still say what we think.
 */

/** No SmartSpectra key at all. A setup problem, and not about the person. */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      `${failureTag('no-api-key')}: SMARTSPECTRA_API_KEY is not set. Register free at ` +
        'https://physiology.presagetech.com/auth/register and put the key in .env',
    )
    this.name = 'MissingApiKeyError'
  }
}

/** Thrown when the person stopped the capture. Not a failure to report as one. */
export class CaptureCancelledError extends Error {
  constructor() {
    super(`${failureTag('cancelled')}: the reading was stopped.`)
    this.name = 'CaptureCancelledError'
  }
}

/**
 * Codes that mean the account or its key, not the camera.
 *
 * A key that is present but rejected, expired or out of credit fails here
 * rather than at the `SMARTSPECTRA_API_KEY` check, because the SDK only finds
 * out when it reaches Presage at session start. Reporting that as a busy
 * camera sends the person to close a video call that was never the problem —
 * a setup fault stated as a hardware one, on the screen least able to afford
 * it (KV-7).
 */
const ACCOUNT_CODES: ReadonlySet<number> = new Set([
  2, // kAuthenticationFailed — key rejected, expired or revoked
  3, // kConfigurationFailed
  4, // kCreditExhausted
])

/**
 * Which failure an SDK error code is, for both the `error` event and the
 * throw out of a lifecycle call. Anything not about the account is left to
 * `camera-unavailable`, whose copy no longer names a cause it cannot know.
 */
export function sdkFailure(
  code: number,
): Extract<CaptureFailure, 'no-api-key' | 'camera-unavailable'> {
  return ACCOUNT_CODES.has(code) ? 'no-api-key' : 'camera-unavailable'
}

/** Reads the numeric `code` the SDK puts on the errors its methods throw. */
export function sdkErrorCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { code } = err as { code?: unknown }
  return typeof code === 'number' ? code : undefined
}

/**
 * A tagged error for an SDK failure, keeping the original as `cause`.
 *
 * The tag has to be in the message — an Error crossing IPC keeps nothing else
 * — but a log on this side can still have the class and stack, so the cause
 * rides along rather than being flattened into the text.
 */
export function captureError(
  failure: TaggedFailure,
  detail: string,
  cause?: unknown,
): Error {
  const message = `${failureTag(failure)}: ${detail}`
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause })
}
