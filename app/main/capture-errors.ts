import { failureTag, type TaggedFailure } from '@core/capture/failure'
import { hasScorableVitals } from '@core/session/usable'
import type { Vitals } from '@core/session/types'

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
      `${failureTag('no-api-key')}: No SmartSpectra key is set. Register free at ` +
        'https://physiology.presagetech.com/auth/register and enter the key on the setup ' +
        'screen (or, in development, set SMARTSPECTRA_API_KEY in .env)',
    )
    this.name = 'MissingApiKeyError'
  }
}

/**
 * Thrown when the person stopped the capture. Defined beside the reply that
 * keeps it out of Electron's handler log (KV-89), and re-exported here with
 * the capture's other errors.
 */
export { CaptureCancelledError } from '../shared/capture-reply'

/**
 * Codes that mean the account or its key, not the camera, should the SDK send
 * them. Reporting a setup fault as a busy camera sends the person to close a
 * video call that was never the problem, on the screen least able to afford
 * it (KV-7).
 *
 * A key that is simply wrong does *not* arrive here. Measured 2026-10-12, in
 * the packaged app with a made-up key, online: every SmartSpectra endpoint
 * answered HTTP 401 ("User authentication required") — the initialize call,
 * the licence check, the model loader, usage verification — and the SDK
 * reported it as `kProcessingFailed` (8), "SmartSpectra processing failed",
 * not `kAuthenticationFailed` (2). So a wrong key arrives as the code an
 * ordinary bad capture gets, and nothing in the `error` event (code, a generic
 * message, `retryable`) is known yet to tell the two apart.
 */
const ACCOUNT_CODES: ReadonlySet<number> = new Set([
  2, // kAuthenticationFailed — key rejected, expired or revoked
  3, // kConfigurationFailed
  4, // kCreditExhausted
])

/**
 * Codes a lost connection could have produced — the only ones an offline
 * device may relabel as `no-connection` (KV-104). 8 is here because it is
 * what the SDK was measured to send with the network down; 5 and 6 because
 * they say so, should they ever arrive.
 */
const CONNECTION_CODES: ReadonlySet<number> = new Set([
  5, // kNetworkError — never observed; the SDK sends 8 instead
  6, // kServerError
  8, // kProcessingFailed — what an offline capture actually reports
])

/**
 * The connection codes that say, in themselves, the service or the way to it
 * — so that online they name the service rather than the camera (KV-19). Not
 * 8: `kProcessingFailed` is what an ordinary bad capture gets too, and naming
 * the service or the key for every reading that did not work is the
 * wrong-cause screen KV-104 removed, with the parts swapped (review of #195).
 */
const SERVICE_CODES: ReadonlySet<number> = new Set([
  5, // kNetworkError
  6, // kServerError
])

/**
 * Which failure an SDK error code is, for both the `error` event and the
 * throw out of a lifecycle call.
 *
 * `online` is passed in rather than read here on purpose. It comes from
 * Electron's `net.isOnline()`, and this module imports neither Electron nor
 * the SDK so that the tags it produces — the contract the screens read — stay
 * testable in the ordinary no-camera suite. A boolean crosses that line; an
 * import would not.
 *
 * **`false` names the connection; `true` names nothing new.** Electron's own
 * documentation says a `false` return is a strong indicator the device cannot
 * reach remote sites, while `true` is inconclusive — a link being up says
 * nothing about whether Presage answered. So an offline device gets the
 * connection named. Online, only a code that itself says the service or the
 * network (5, 6) is named `service-refused`, where the household's key is one
 * possibility (KV-19); 8 stays `camera-unavailable`, whose copy still hedges
 * toward the connection because that remains possible (KV-104). A wrong key
 * online arrives as 8 too — measured, see `ACCOUNT_CODES` — so it reads as the
 * camera today: naming the key for every 8 would blame it for every bad
 * capture, and nothing yet tells the two apart (review of #195).
 *
 * The SDK cannot answer this itself: measured on a real capture with the
 * network down, it reports `kProcessingFailed` (8) — the same code a genuinely
 * bad capture gets — rather than `kNetworkError` (5), which never arrives.
 *
 * **And being offline only explains the codes a connection could.** Everything
 * outside `CONNECTION_CODES` is a fact the SDK established on this machine —
 * an input it could not open, a frame it could not convert — and it is no less
 * true for the Wi-Fi being off. Naming the connection over it would send the
 * person to reconnect, only to be told on the next try that the camera is
 * held: the wrong-cause screen KV-104 exists to remove, with the parts swapped.
 */
export function sdkFailure(
  code: number | undefined,
  online: boolean,
): Extract<
  TaggedFailure,
  'no-api-key' | 'camera-unavailable' | 'no-connection' | 'service-refused'
> {
  // Account problems are named whether or not the device is online: the SDK
  // only learns of them by reaching Presage, so it was online enough to ask.
  if (code !== undefined && ACCOUNT_CODES.has(code)) return 'no-api-key'
  // A throw with no code is left alone too. The lifecycle path that produces
  // one is `useCamera()`, which is local, and the measured offline failure
  // arrived as code 8 on the `error` event — not as a throw.
  if (code !== undefined && CONNECTION_CODES.has(code)) {
    // Offline, the connection explains it.
    if (!online) return 'no-connection'
    // Online, a code that says the service or the network names the service
    // (KV-19). 8 does not: a bad capture sends it too (review of #195).
    if (SERVICE_CODES.has(code)) return 'service-refused'
  }
  return 'camera-unavailable'
}

/**
 * The failure a capture that ran to its ceiling should report instead of
 * resolving, or null when what it collected should be kept (KV-104).
 *
 * The one fast offline failure measured arrived as an error, but that is two
 * runs on one machine. If the SDK ever goes quiet instead, the capture runs
 * its whole ceiling and resolves with nothing, and the person reads that the
 * camera ran but no reading came out — on the one path where the SDK said
 * nothing and the connection is the likeliest reason. Only *nothing* counts:
 * a capture that measured anything at all was not stopped by the connection,
 * and is kept and judged by the scorer like any other.
 */
export function emptyCaptureFailure(vitals: Vitals, online: boolean): 'no-connection' | null {
  return !online && !hasScorableVitals(vitals) ? 'no-connection' : null
}

/**
 * What a failure *setting the SDK up* rejects with: the constructor and the
 * event registrations, before anything has asked for the camera (KV-80
 * review).
 *
 * Not `sdkFailure`. That is written for `useCamera()` and `start()`, where the
 * camera is genuinely being opened, so anything it does not recognise falls to
 * `camera-unavailable` — "another program may have it open". Here nothing has
 * selected a device, so that sentence would name one nobody touched, to the
 * person in front of it. Only an account code means anything this early; the
 * connection cannot, since the SDK reaches Presage at session start (KV-65).
 *
 * Anything else is returned **untagged**, and reads as `unknown`, which names
 * no cause. The SDK's typings document codes on the lifecycle methods only, so
 * a codeless throw is the likely shape here.
 */
export function setupFailure(err: unknown): unknown {
  const code = sdkErrorCode(err)
  return code !== undefined && ACCOUNT_CODES.has(code)
    ? captureError('no-api-key', 'the capture could not be set up.', err)
    : err
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
