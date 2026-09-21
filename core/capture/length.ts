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
 *
 * **Expect that to be every run, for now.** HRV has arrived in 1 of 8 captures
 * on the only hardware this has been tried on, so the early stop is a bet that
 * better conditions exist rather than something observed working. Until it is
 * seen to fire, this is a 90-second capture, and the person whose camera never
 * produces HRV waits longest for least — every time, not occasionally.
 */
export const DEFAULT_CAPTURE_SECONDS = 90

/**
 * How long to keep going after the last metric arrives.
 *
 * **Not for the reason first given.** This was justified by `Tracked`
 * preferring the newest reading the SDK called settled — which does not
 * operate on HRV, the metric that by this design always completes the set:
 * `CLAUDE.md` records that only `cardio.pulseRate[]` and `breathing.rate[]`
 * ever set `stable`, so `hrv.latestStable` is permanently undefined and the
 * margin cannot promote anything.
 *
 * What it actually buys is one more *raw* HRV sample, because a first reading
 * is the noisiest, and only if the SDK emits HRV more than once in this
 * window — an interval nobody has measured. So this is a guess resting on an
 * unmeasured assumption, which is a weaker footing than the ceiling's.
 *
 * #63 owns both, and should measure the HRV emission interval before deciding
 * whether this earns its five seconds at all.
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
