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

/**
 * The longest a capture runs when nothing says otherwise — a **ceiling**, not
 * a duration.
 *
 * A capture ends as soon as every scorable metric has reported, so most runs
 * finish well before this. The ceiling can therefore be generous, which is the
 * point: a number tuned for the average cuts off the person whose signal was
 * slow, and a number tuned for the worst case takes that long from everyone.
 *
 * 90 rather than 60 because the one measured run that collected HRV took 58s
 * of capture, and one sample is not a distribution. A run that reaches this is
 * one where something did not arrive at all, and it is scored on what did.
 */
export const DEFAULT_CAPTURE_SECONDS = 90

/**
 * How long to keep going after the last metric arrives.
 *
 * Stopping the instant HRV first appears would report its first reading, and a
 * first reading is the noisiest one — `Tracked` prefers the newest the SDK
 * called settled, which needs more than one to choose from. A few seconds buys
 * that without costing the person a minute.
 *
 * A guess, like the ceiling. #63 owns both.
 */
export const SETTLE_AFTER_COMPLETE_SECONDS = 5

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
