import { MIN_CAPTURE_SECONDS } from '../scoring'

/**
 * How long a capture runs.
 *
 * In `core/` because three sides need the same number and none of them can see
 * each other's: the main process runs the capture, the renderer counts it down
 * and promises it in words, and the scorer decides whether what came back was
 * long enough to use. Keeping the default in `app/main` left the renderer and
 * `captureVitals` each holding their own `30`, so changing it moved one and not
 * the others — the drift #63 set out to remove, one level along.
 *
 * Reading the environment is *not* here. That is a main-process concern and
 * stays in `app/main/capture-length.ts`; this is only the numbers.
 */

/** Seconds of capture when nothing says otherwise. */
export const DEFAULT_CAPTURE_SECONDS = 30

/**
 * How much of a capture the camera can eat before the first reading lands.
 *
 * `Vitals.durationSec` records seconds of *capture* — measured from the first
 * frame, not from the request — so a setting is always longer than what the
 * scorer is handed. Measured at ~2s on one machine (a 30s request recorded 28,
 * a 60s request recorded 58), but `captureVitals` warns it can be several, and
 * a generous allowance here only costs a slightly higher floor.
 *
 * A guess, like the rest. #63 owns it.
 */
export const CAMERA_OPEN_ALLOWANCE_SECONDS = 10

/**
 * The shortest setting that can still produce a scoreable check-in.
 *
 * Derived rather than written down, because the relationship is the point: the
 * scorer rejects a capture whose *recorded* duration is under
 * `MIN_CAPTURE_SECONDS`, and the recorded duration is the setting minus the
 * camera-open time. A bare `25` looked safe against a 20s gate and was not —
 * on a machine that takes 6s to open the camera it records 19 and the check-in
 * is discarded, which is exactly what the floor exists to prevent.
 */
export const SHORTEST_USEFUL_SECONDS = MIN_CAPTURE_SECONDS + CAMERA_OPEN_ALLOWANCE_SECONDS

/** Above this nobody is going to sit still, whatever the metrics want. */
export const LONGEST_REASONABLE_SECONDS = 180
