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
 *
 * The numbers live in `core/capture/length.ts` so the renderer's countdown and
 * `captureVitals`' own default reference the same one. Reading the environment
 * is a main-process concern and stays here.
 */
import {
  DEFAULT_CAPTURE_SECONDS,
  LONGEST_REASONABLE_SECONDS,
  SHORTEST_USEFUL_SECONDS,
} from '@core/capture/length'

export {
  CAMERA_OPEN_ALLOWANCE_SECONDS,
  DEFAULT_CAPTURE_SECONDS,
  LONGEST_REASONABLE_SECONDS,
  SHORTEST_USEFUL_SECONDS,
} from '@core/capture/length'

/** Set this to run longer or shorter captures, e.g. for #63. */
export const CAPTURE_SECONDS_ENV = 'KINVUE_CAPTURE_SECONDS'

/**
 * The capture length for this run, and whether the request was honoured.
 *
 * Falls back to the default for anything unusable rather than throwing: a typo
 * in an env var must not stop the app recording a check-in. Out-of-range values
 * are clamped rather than rejected — someone trying 200 wants a long capture,
 * not the default — but the clamp is reported, because silently running 30s
 * captures when the file says 10 leaves the mismatch with `.env` as the only
 * evidence.
 */
export function captureSeconds(env: NodeJS.ProcessEnv): number {
  return resolveCaptureSeconds(env).seconds
}

/** What `captureSeconds` decided, and why. Separated so it can be reported. */
export interface CaptureLengthChoice {
  seconds: number
  /** The raw setting, when it was replaced by something else. */
  replaced?: string
}

export function resolveCaptureSeconds(env: NodeJS.ProcessEnv): CaptureLengthChoice {
  const raw = env[CAPTURE_SECONDS_ENV]
  if (raw === undefined || raw.trim() === '') return { seconds: DEFAULT_CAPTURE_SECONDS }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return { seconds: DEFAULT_CAPTURE_SECONDS, replaced: raw }
  const whole = Math.round(parsed)
  if (whole < SHORTEST_USEFUL_SECONDS) return { seconds: SHORTEST_USEFUL_SECONDS, replaced: raw }
  if (whole > LONGEST_REASONABLE_SECONDS) {
    return { seconds: LONGEST_REASONABLE_SECONDS, replaced: raw }
  }
  return { seconds: whole }
}

/** The line to print when a setting was not honoured, or null when it was. */
export function captureLengthLogLine(choice: CaptureLengthChoice): string | null {
  if (choice.replaced === undefined) return null
  return `[capture] KINVUE_CAPTURE_SECONDS=${choice.replaced} is not usable; running ${choice.seconds}s`
}
