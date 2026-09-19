/**
 * What of the camera's framing advice is worth putting in front of the person.
 *
 * The SDK reports how usable the shot is at camera rate — roughly 30 times a
 * second — and most of that is not advice anyone can act on. Two things are
 * being filtered out:
 *
 * - **The camera complaining about itself.** Six real captures (KV-1), well lit
 *   and badly lit alike, each emitted a burst of "too dark" while exposure
 *   settled, about a second long, and nothing afterwards. Passing that through
 *   would open every check-in by telling the person to turn on a light, which
 *   teaches them to ignore the advice that matters.
 * - **Flicker.** Someone slightly off-centre *and* slightly too far makes the
 *   SDK alternate between two codes; forwarding each change would swap the
 *   instruction dozens of times a second while they are trying to follow it.
 *
 * Both are handled by requiring advice to *hold* before it is shown, rather
 * than by waiting out a fixed opening window. A code that persists is real on
 * any machine, while a wall-clock window has to be calibrated against how long
 * one particular camera takes to open (KV-63) and silently stops working on a
 * slower one.
 */

/** Advice the capture layer has already put into the person's own words. */
export interface CaptureGuidance {
  message: string
  /**
   * True for codes a settling camera produces on its own — exposure and
   * tuning. These have to hold for much longer before they are believed.
   * Framing advice is never an artefact: nobody is out of frame by accident
   * of warm-up, and it is the most actionable thing the SDK reports.
   */
  settlingArtefact: boolean
}

/** Show this line, or clear what is on screen. Null means: nothing to change. */
export type GuidanceUpdate = { show: string } | { clear: true }

/** How long ordinary advice must hold before the person is shown it. */
export const GUIDANCE_PERSIST_MS = 400

/**
 * How long exposure advice must hold. Past the observed settling burst, so a
 * room that is genuinely too dark is still reported — a few seconds later than
 * a framing problem, which is the cost of not crying wolf on every check-in.
 */
export const SETTLING_PERSIST_MS = 2_500

/** A line already on screen is not re-sent more often than this. */
export const GUIDANCE_REPEAT_MS = 4_000

export interface GuidanceGate {
  /**
   * `advice` is null when the SDK reports the shot is fine. `atMs` must come
   * from a monotonic clock — a wall clock stepped by NTP mid-capture would
   * mute guidance or let the settling burst through.
   */
  offer(advice: CaptureGuidance | null, atMs: number): GuidanceUpdate | null
}

export function createGuidanceGate(): GuidanceGate {
  /** The advice currently being observed, and when it first appeared. */
  let candidate: string | undefined
  let candidateSince = 0
  let candidateSettling = false

  /** What the person is looking at, and when it was sent. */
  let onScreen: string | undefined
  let sentAt = 0

  return {
    offer(advice, atMs) {
      const message = advice?.message

      if (message !== candidate) {
        candidate = message
        candidateSince = atMs
        candidateSettling = advice?.settlingArtefact === true
      }

      // The shot is fine. Clearing is advice too — someone who sat back when
      // told to must not still be reading "sit back" thirty seconds later —
      // and it waits to hold like anything else, so a single good frame in a
      // bad stretch does not blink the instruction away.
      if (advice === null) {
        if (onScreen === undefined) return null
        if (atMs - candidateSince < GUIDANCE_PERSIST_MS) return null
        onScreen = undefined
        return { clear: true }
      }

      const needed = candidateSettling ? SETTLING_PERSIST_MS : GUIDANCE_PERSIST_MS
      if (atMs - candidateSince < needed) return null

      // Already on screen: repeat only once it is stale, so the line does not
      // keep pulling attention back while the person is acting on it.
      if (message === onScreen && atMs - sentAt < GUIDANCE_REPEAT_MS) return null

      onScreen = message
      sentAt = atMs
      return { show: message as string }
    },
  }
}
