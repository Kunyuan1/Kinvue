/**
 * How long a capture runs, and where that number comes from.
 *
 * Settable because #63 cannot be answered without changing it: the KV-1 run
 * recorded breathing first arriving at ~13s, pulse at ~20s and **HRV at ~34s**,
 * and the default has always been 30. Five captures on real hardware produced
 * breathing 5/5, pulse 3/5 and HRV 0/5, which is what that ordering predicts —
 * the capture ends before HRV exists. `hrv-drop` is the only vitals rule that
 * can reach the elevated threshold alone, so on those timings the rule the
 * product leans on hardest can never fire.
 *
 * That wants measuring across several lengths rather than one more guess, and
 * measuring it meant editing three files that could disagree: the default here,
 * the renderer's countdown, and the sentence under the button. They now follow
 * one number.
 *
 * Not a tuned constant yet. #63 is where the default gets settled once there
 * are timings to settle it against.
 */

/** Seconds of capture when nothing says otherwise. */
export const DEFAULT_CAPTURE_SECONDS = 30

/** Set this to run longer or shorter captures, e.g. for #63. */
export const CAPTURE_SECONDS_ENV = 'KINVUE_CAPTURE_SECONDS'

/**
 * Below this the scorer would reject every capture as too short.
 * `MIN_CAPTURE_SECONDS` in `core/scoring` is 20, and a capture also loses a
 * few seconds to the camera opening, so anything under this is a setting that
 * cannot produce a scoreable check-in.
 */
export const SHORTEST_USEFUL_SECONDS = 25

/** Above this nobody is going to sit still, whatever the metrics want. */
export const LONGEST_REASONABLE_SECONDS = 180

/**
 * The capture length for this run.
 *
 * Falls back to the default for anything unusable rather than throwing: a typo
 * in an env var must not stop the app recording a check-in, and a capture at
 * the default is the behaviour that already existed. Out-of-range values are
 * clamped rather than rejected for the same reason — someone trying 200 wants
 * a long capture, not the default.
 */
export function captureSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env[CAPTURE_SECONDS_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_CAPTURE_SECONDS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_CAPTURE_SECONDS
  const whole = Math.round(parsed)
  if (whole < SHORTEST_USEFUL_SECONDS) return SHORTEST_USEFUL_SECONDS
  if (whole > LONGEST_REASONABLE_SECONDS) return LONGEST_REASONABLE_SECONDS
  return whole
}
