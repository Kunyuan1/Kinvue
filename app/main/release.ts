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

/** Whether the device reported itself free before the wait ran out. */
export type ReleaseOutcome = 'released' | 'failed' | 'timed-out'

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
