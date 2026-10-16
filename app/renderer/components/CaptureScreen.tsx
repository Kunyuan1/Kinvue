import { useEffect, useRef, useState } from 'react'
import type { CaptureFailure } from '@core/capture/failure'
import { PERSON_BUTTON, PERSON_NOTE, useFocusWhenShown } from './person'

/**
 * How long after the screen opens the countdown's length is said aloud (KV-20).
 * The heading is read first, as focus lands on it; a live region filled in the
 * same moment it is drawn is one screen readers often miss, and one filled
 * while the heading is still being read is talked over.
 */
export const COUNTDOWN_ANNOUNCE_DELAY_MS = 1000

/**
 * The ~30 seconds in front of the camera.
 *
 * **This is the one screen the cared-for person reads, not the caregiver.**
 * Everywhere else in this app is addressed to whoever looks after them; here
 * the second person is the person being measured, and the instructions are
 * theirs to act on. Keep the two apart.
 *
 * It exists because of what KV-1 measured: two real captures returned no
 * readings at all, purely because a face sat at the bottom of the frame and
 * the person could not see it. Bad framing and poor light are the likeliest
 * way a capture comes back empty, and the only failure the person can fix
 * while it is still running — so the self-view and the guidance line are the
 * point of this screen, not decoration around a countdown.
 *
 * Read by someone who may not see well (KV-20): its heading takes focus as it
 * opens and when a failure replaces it, and nothing else moves focus while the
 * camera runs. The advice is announced as it changes; the countdown only twice,
 * how long it will take and that it is finishing — said every second, it would
 * talk over the advice that is the point of the screen.
 */

/**
 * Shows a capture that is **already running**. Starting one is deliberately not
 * done here: a capture cannot be cancelled once the camera is open, and React
 * runs an effect, tears it down and runs it again in development. That turned
 * one button press into two captures, the second of which main correctly
 * refused with "a capture is already running" — the first thing this screen
 * did on real hardware. A side effect nothing can take back belongs to the
 * press, not to a render.
 */
/**
 * What each failure says, addressed to the person in front of the camera.
 *
 * `no-api-key` and `camera-unavailable` are not about them at all — a key
 * nobody has set, a camera another application is holding — so both say that
 * nothing is wrong on their side. Reading as though they were would be the
 * app blaming someone for its own setup (KV-7). `capture-in-progress` and
 * `unknown` make no claim either way.
 *
 * `unknown` used to say "Something went wrong with the camera" — a cause,
 * and nearly always the wrong one (KV-80). Every SDK call that touches the
 * camera or the service is tagged and has its own sentence above, so what
 * reaches `unknown` is a fault inside the app: its own code, a tag that
 * belongs to the other screen, or the SDK failing to be set up before any
 * camera was asked for. Naming the camera blamed it, to the one person in
 * this app who is being filmed.
 *
 * Nor does it advise a retry. Everything that reaches it is deterministic —
 * a malformed reply or a missing id fails the same way every time — and
 * "trying again is worth a go" is a claim about that, not a shrug (the lesson
 * KV-13 taught the questions screen). So it says whose problem it is, which is
 * true of all of them, and who can act, as `no-api-key` does.
 *
 * `no-connection` is the exception, and deliberately so. Telling someone
 * whose Wi-Fi is off that nothing is wrong on their side is untrue, and it is
 * the one thing that would stop anyone looking at the connection (KV-104). But
 * it does not hand them the fix either: this is the one screen the cared-for
 * person reads, and reconnecting is closer to setup than to anything asked of
 * them — so it names the cause and stops there. Nor does it say "try again":
 * the only control here is Go back (KV-76).
 */
const FAILURE: Record<CaptureFailure, { title: string; detail: string }> = {
  'no-api-key': {
    // Missing, refused, out of credit — or a configuration the service would
    // not take, which is not the key (kConfigurationFailed): so the title
    // claims setup, not the key, and the key is named as the likeliest part of
    // it (KV-19, review of #195).
    title: 'Kinvue is not set up to take a reading',
    detail:
      'Its key from SmartSpectra is missing or was not accepted, or something else in how ' +
      'it is set up is not right. Nothing is wrong on your side — whoever set this up can ' +
      'check it.',
  },
  'camera-unavailable': {
    // Still hedges toward the connection, because `net.isOnline()` returning
    // true is inconclusive — a link that is up says nothing about whether
    // Presage was reachable (KV-104). Only the `false` case is certain enough
    // to name, and that one has its own screen below.
    title: 'The camera could not be used',
    detail:
      'Another program may have it open — a video call, perhaps — or it may be the ' +
      'connection. Trying again in a moment is usually enough, and nothing is wrong ' +
      'on your side.',
  },
  'no-connection': {
    title: 'There is no internet connection',
    detail:
      'A reading needs the internet, and there is none right now, so this check-in ' +
      'could not be finished. It can be taken once the connection is back.',
  },
  'service-refused': {
    // Online, and the service would not run it: a network or server code, or a
    // failure before any frame was judged — measured as what a wrong key does
    // (KV-19, review of #195). The key is named first, the service second, and
    // neither is claimed.
    title: 'The reading could not be started',
    detail:
      'The service that reads the camera would not run it. Kinvue’s key may be wrong or ' +
      'used up, or the service may be busy. Nothing is wrong on your side — whoever set ' +
      'this up can check the key.',
  },
  'capture-in-progress': {
    // Says what the button does, because the button is the only way out of
    // this state (KV-76). The previous reading is still running, but waiting
    // for it gains nothing — by the time it finishes this screen has moved on
    // and its result is dropped — and this screen offers no way to retry. So
    // "try again in a few seconds" asked for a wait that led nowhere, next to
    // the one control that ends the thing being waited for.
    //
    // "in a moment" is describing a real short wait rather than hedging around
    // a race. Since KV-84 a capture does not settle, and so does not drop its
    // lock, until the camera is free *or a two-second wait has run out*, so
    // pressing Take a reading too soon lands back on this screen rather than on
    // "another program may have it open", which pointed at a video call that
    // was never the problem.
    //
    // Not a guarantee, and saying so is the stronger argument: on a timeout the
    // lock drops with the device possibly still held, and that press does get
    // the wrong sentence. The bound is chosen so that is rare — measured
    // releases on real hardware ran 416–593ms against it — not so it is
    // impossible. #63 owns the number.
    title: 'The camera is still busy',
    detail:
      'It has not finished with the reading before this one. Going back will stop that ' +
      'reading and release the camera, so a new one can start in a moment.',
  },
  unknown: {
    title: 'The reading could not be taken',
    detail:
      'Something went wrong inside the app, and nothing is wrong on your side. ' +
      'Whoever set it up may need to look at it.',
  },
}

export default function CaptureScreen({
  failure,
  onCancel,
  captureSeconds,
}: {
  failure: CaptureFailure | null
  onCancel: () => void
  /** What main will actually run, so the countdown cannot promise a different
   *  number from the capture (#63). */
  captureSeconds: number
}): React.JSX.Element {
  const [elapsedSec, setElapsedSec] = useState(0)
  // Main says so once every metric has arrived. Without it the countdown runs
  // off the ceiling, so a capture that finished at 40s read "Up to 50 seconds
  // left" and then vanished (#63).
  const [settling, setSettling] = useState(false)
  const [guidance, setGuidance] = useState<string | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const latestUrl = useRef<string | null>(null)
  const previousUrl = useRef<string | null>(null)
  const [lengthSaid, setLengthSaid] = useState(false)
  // Focused on opening, and again when a failure replaces the capture: the
  // Stop button that had focus is gone with it.
  const heading = useFocusWhenShown<HTMLHeadingElement>(failure)

  useEffect(() => {
    const timer = setTimeout(() => setLengthSaid(true), COUNTDOWN_ANNOUNCE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    // Subscriptions only, which are safe to set up and tear down twice.
    const offProgress = window.kinvue.onCaptureProgress(setElapsedSec)
    const offSettling = window.kinvue.onCaptureSettling(() => setSettling(true))
    const offGuidance = window.kinvue.onCaptureGuidance(setGuidance)
    const offFrame = window.kinvue.onCaptureFrame((jpeg) => {
      // Main says null when this camera's frames cannot be converted. Nothing
      // more is coming, so say so instead of waiting.
      if (jpeg === null) {
        setPreviewFailed(true)
        return
      }
      // Copied into a fresh view: the IPC payload is typed over a shared
      // ArrayBufferLike, which Blob will not take directly.
      const url = URL.createObjectURL(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }))
      // The previous URL is kept one generation. Revoking it the instant its
      // replacement is set can pull it out from under a browser that has
      // committed the new src but not yet fetched it, which fails the load and
      // — before this — killed the preview for the rest of the capture.
      const stale = previousUrl.current
      previousUrl.current = latestUrl.current
      latestUrl.current = url
      if (stale !== null) URL.revokeObjectURL(stale)
      setFrameUrl(url)
    })

    return () => {
      offProgress()
      offSettling()
      offGuidance()
      offFrame()
      for (const url of [latestUrl.current, previousUrl.current]) {
        if (url !== null) URL.revokeObjectURL(url)
      }
      latestUrl.current = null
      previousUrl.current = null
    }
  }, [])

  // A ceiling, not a duration: the capture ends as soon as every metric has
  // arrived, which is usually sooner (#63). So this counts down the longest it
  // could take, and finishing early is the common case rather than a surprise.
  const remaining = Math.max(0, captureSeconds - elapsedSec)
  const finishing = settling || remaining === 0

  if (failure !== null) {
    const { title, detail } = FAILURE[failure]
    return (
      <section className="mx-auto max-w-xl text-center">
        {/* The detail is not tied to the heading with aria-describedby: it is
            the next thing read after it, so describing it too read the same
            sentence twice, one arrow apart (review of #196). */}
        <h2 ref={heading} tabIndex={-1} className="text-2xl font-semibold">
          {title}
        </h2>
        <p className={`mt-3 ${PERSON_NOTE}`}>{detail}</p>
        <button type="button" onClick={onCancel} className={`mt-6 ${PERSON_BUTTON}`}>
          Go back
        </button>
      </section>
    )
  }

  return (
    <section className="mx-auto max-w-xl text-center">
      <h2 ref={heading} tabIndex={-1} className="text-2xl font-semibold">
        Sit comfortably and look at the camera
      </h2>

      <div className="relative mt-6 overflow-hidden rounded-xl border border-(--color-line) bg-(--color-raised)">
        {previewFailed ? (
          // Said out loud rather than left blank. A picture that silently never
          // arrives is how the first real run looked, and it took a CSP rule to
          // explain: the advice below is what matters, and it still works.
          <p className={`px-6 py-16 ${PERSON_NOTE}`}>
            The picture is not available on this machine. The advice below still applies.
          </p>
        ) : frameUrl === null ? (
          <p className={`px-6 py-16 ${PERSON_NOTE}`}>Starting the camera…</p>
        ) : (
          // Mirrored, so moving left moves the picture left: a self-view that
          // reverses your own movements is harder to frame by, not easier.
          <img
            src={frameUrl}
            alt=""
            onError={() => setPreviewFailed(true)}
            // One frame failing to load is not the camera failing. Frames keep
            // arriving, so the next one that draws puts the picture back.
            onLoad={() => setPreviewFailed(false)}
            className="w-full -scale-x-100"
          />
        )}
      </div>

      {/* Only real advice is announced. Keeping the reassurance line in the
          live region would read it out again every time the shot goes back to
          being fine, which is constantly while someone is adjusting. The two
          share one place on screen, so the line does not jump when advice
          comes and goes. */}
      <div className="mt-4 grid min-h-7 text-xl">
        <p aria-live="polite" className="col-start-1 row-start-1">
          {guidance}
        </p>
        {guidance === null && (
          <p className="col-start-1 row-start-1">Holding still is all that is needed.</p>
        )}
      </div>

      {/* Shown every second, not announced every second (KV-20) — and hidden
          from a screen reader, which hears the region below instead. Left in,
          reading on from the heading said "Up to 23 seconds left. This takes
          up to 30 seconds.": two numbers that disagree (review of #196). */}
      <p aria-hidden="true" className={`mt-2 ${PERSON_NOTE}`}>
        {finishing ? 'Finishing up…' : `Up to ${remaining} seconds left`}
      </p>
      <p aria-live="polite" className="sr-only">
        {finishing
          ? 'Finishing up.'
          : lengthSaid
            ? `This takes up to ${captureSeconds} seconds.`
            : ''}
      </p>

      {/* Stops the camera for real: main abandons the capture and releases the
          device. A button that said Stop and left the camera running for
          another half minute would be the wrong lie on the one screen the
          person being filmed reads. */}
      <button type="button" onClick={onCancel} className={`mt-6 ${PERSON_BUTTON}`}>
        Stop
      </button>
    </section>
  )
}
