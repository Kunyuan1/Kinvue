/**
 * Waiting for the camera to actually be free.
 *
 * The SDK is torn down with `stopAsync()` then `destroy()`, and until KV-84
 * nothing waited for either. The capture's *lock* cleared the moment the
 * promise settled while the *device* was released whenever those two happened
 * to finish, so a person told "a new reading can start" could press Take a
 * reading and be told the camera was in use by another program — pointed at a
 * video call that was never the problem (KV-7 is the standing example of why
 * that sentence is the wrong one to guess at).
 *
 * Split out of `vitals.ts` for the reason `metrics.ts` and `in-flight.ts` were:
 * that module imports the SDK, which loads a native runtime through koffi at
 * import time, so nothing in it can be unit-tested.
 */

/**
 * How long to wait for the device before giving up on it.
 *
 * A guess, and deliberately a short one. Waiting is what makes
 * `capture-in-progress` mean "the camera is genuinely in use"; waiting
 * *forever* would turn a teardown that hangs into a lock nobody can clear,
 * which is the KV-76 failure wearing different clothes. #63 owns the capture
 * constants nobody has measured, and this belongs with them.
 */
export const DEVICE_RELEASE_TIMEOUT_MS = 2000

/**
 * Whether the device reported itself free before the wait ran out.
 *
 * **The two failures are not the same kind of thing, and `timed-out` is the
 * worse one.** `failed` means both teardown calls ran and something complained:
 * the device is probably down. `timed-out` means the wait ran out with the
 * teardown still in flight, so the lock is dropped while the camera may well
 * still be held — which is the state the next capture blames on another
 * program. Nothing branches on this yet; it decides what gets said.
 */
export type ReleaseOutcome = 'released' | 'failed' | 'timed-out'

/** The part of the SDK a teardown needs. Narrow, so it can be faked in a test. */
export interface Teardownable {
  stopAsync(): Promise<void>
  destroy(): Promise<void>
}

/**
 * Stop the session and tear it down, in that order, **both of them**.
 *
 * `destroy()` is what actually frees the device — the SDK's own typing calls
 * it the teardown, says it is idempotent, and warns that native SDK state is
 * process-global. So it runs on `finally` rather than `then`: a stop that
 * rejected is the one case where the camera is certainly still held, and
 * chaining on success skipped the teardown on exactly that branch.
 *
 * The rejection still propagates, so a teardown that complained is still
 * reported as `failed` — what changes is that the device was actually let go
 * first.
 */
export async function teardown(sdk: Teardownable): Promise<void> {
  await sdk.stopAsync().finally(async () => {
    await sdk.destroy()
  })
}

/** Set this to any non-empty value to print how long the camera took to close. */
export const RELEASE_LOG_ENV = 'KINVUE_LOG_CAPTURE'

/**
 * The line to print for a finished teardown, or null when there is nothing to
 * say (KV-84).
 *
 * `DEVICE_RELEASE_TIMEOUT_MS` is a guess and #63 owns settling it, which needs
 * a number from real hardware that nobody can currently see: the outcome was
 * returned and dropped, because `app/main` has no logger and this PR is not
 * the place to invent a logging policy. So the happy path stays silent unless
 * asked, and the two outcomes that mean something went wrong always speak — a
 * camera that failed to close or outran the wait is the thing the next capture
 * will blame on another program.
 *
 * Returned rather than printed so the decision is testable without capturing
 * stdout.
 */
export function releaseLogLine(
  outcome: ReleaseOutcome,
  elapsedMs: number,
  asked: boolean,
  afterStop = false,
): string | null {
  if (outcome === 'released' && !asked) return null
  // Stopping mid-capture tears a running pipeline down out of order, so a
  // teardown that complains there is a different thing from one that complains
  // on a capture that ran to the end — and "the person pressed stop" is the
  // distinction a reader needs before deciding the device is stuck.
  const cause = afterStop ? ' (after a stop)' : ''
  // `timed-out` resolves *at* the bound, so its elapsed is the bound plus
  // jitter by construction and printing both invites a reader to find meaning
  // in the difference. The outcome carries which number it is.
  if (outcome === 'timed-out') {
    return `[capture] camera release: gave up waiting after ${DEVICE_RELEASE_TIMEOUT_MS}ms${cause}`
  }
  return `[capture] camera release: ${outcome} in ${elapsedMs}ms${cause}`
}

/** Whether the run was asked for capture timings. */
export const askedForCaptureLog = (env: NodeJS.ProcessEnv): boolean => {
  const value = env[RELEASE_LOG_ENV]
  return value !== undefined && value !== ''
}

/**
 * Wait for a teardown, bounded, and report how it went.
 *
 * **Never rejects.** A capture that produced a good reading must not turn into
 * an error because the camera took an odd route to closing, and a capture that
 * already failed has its own reason to report. The outcome is returned instead
 * so the caller can decide, and so the failure stops being swallowed silently
 * the way `.catch(() => undefined)` swallowed it.
 */
export async function awaitRelease(
  teardown: Promise<unknown>,
  timeoutMs: number = DEVICE_RELEASE_TIMEOUT_MS,
): Promise<ReleaseOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), timeoutMs)
  })
  try {
    return await Promise.race([
      teardown.then(
        (): ReleaseOutcome => 'released',
        (): ReleaseOutcome => 'failed',
      ),
      expiry,
    ])
  } finally {
    // Otherwise a fast teardown leaves a live timer holding the process open
    // for the rest of the window — which in Electron's main process is the
    // difference between quitting and appearing to hang.
    clearTimeout(timer)
  }
}
