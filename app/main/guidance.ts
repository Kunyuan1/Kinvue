/**
 * What of the SDK's framing advice is worth showing the person.
 *
 * The SDK emits `validationStatus` at camera rate — roughly 30 a second — and
 * the opening seconds of every capture are noise. Measured across six real
 * captures (KV-1), well lit and badly lit alike: each emitted exactly 57
 * "increase light on face" hints between about 4s and 5s while the camera was
 * still settling its exposure, and none afterwards. Forwarding the stream
 * straight through would tell every person to turn on a light at the start of
 * every check-in, and then flicker.
 *
 * This is in main rather than in the screen (#3) because a renderer that
 * forgets the rule would put the wrong advice in front of the person, and
 * trusting the renderer less is the whole shape of the capture path.
 *
 * Imports nothing, so it is tested without a camera.
 */

/**
 * How long the camera is given to settle before its complaints are believed.
 * The observed burst ends at about 5s; this is deliberately past it, at the
 * cost of a person sitting in genuine darkness waiting a moment longer to be
 * told. KV-63 owns the capture-length constants and should revisit this with
 * timings from more than one machine.
 */
export const GUIDANCE_SETTLE_MS = 6_000

/**
 * A repeat of advice already on screen is not news. Re-sending the same line
 * keeps a reader's attention on it, which is the opposite of what someone
 * trying to fix their framing needs.
 */
export const GUIDANCE_REPEAT_MS = 4_000

export interface GuidanceGate {
  /** The message to show, or null when this one should not be shown now. */
  offer(message: string, atMs: number): string | null
}

/** `startedAt` is when the capture began, in the same clock as `atMs`. */
export function createGuidanceGate(startedAt: number): GuidanceGate {
  let showing: string | undefined
  let shownAt = 0

  return {
    offer(message, atMs) {
      // Nothing during the settle window: the camera is complaining about its
      // own exposure, not about the person.
      if (atMs - startedAt < GUIDANCE_SETTLE_MS) return null

      const changed = message !== showing
      if (!changed && atMs - shownAt < GUIDANCE_REPEAT_MS) return null

      showing = message
      shownAt = atMs
      return message
    },
  }
}
