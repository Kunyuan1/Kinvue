/**
 * Which capture is running, so the person in front of the camera can stop it.
 *
 * Split out of `index.ts` for the reason `metrics.ts` and `capture-errors.ts`
 * were: that module imports Electron, so nothing in it can be unit-tested, and
 * this is ownership bookkeeping with an ordering bug in it rather than plumbing.
 *
 * **The rule is that only a capture that actually started owns the slot.**
 * `index.ts` used to claim it before calling `checkIn.capture`, which refuses a
 * second capture while one is running (KV-76). So a refused capture overwrote
 * the running one's controller and then cleared it on the way out, and the
 * capture that was genuinely running could no longer be aborted by anything —
 * the camera stayed on for its full thirty seconds with the screen offering a
 * button that did nothing. `app/main/vitals.ts` states the invariant that
 * breaks: a screen that offers to stop has to actually stop (KV-3).
 */
export interface InFlightCapture {
  /**
   * Claim the slot. Called once the capture has started, never before: a
   * capture that is about to be refused must not take it from the one running.
   */
  claim(controller: AbortController): void
  /** Release the slot, but only when it is still this capture's to release. */
  release(controller: AbortController): void
  /** Abandon whatever is running. Does nothing when nothing is. */
  abort(): void
  /** Whether a capture currently owns the slot. */
  readonly running: boolean
}

export function createInFlightCapture(): InFlightCapture {
  let current: AbortController | null = null
  return {
    claim(controller) {
      current = controller
    },
    release(controller) {
      // Not an unconditional clear: a refused capture running its own cleanup
      // must not release the slot belonging to the capture that refused it.
      if (current === controller) current = null
    },
    abort() {
      current?.abort()
    },
    get running() {
      return current !== null
    },
  }
}
