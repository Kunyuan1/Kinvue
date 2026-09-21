import { useEffect, useRef, useState } from 'react'
import type { CaptureFailure } from '@core/capture/failure'

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
 */

const CAPTURE_SECONDS = 30

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
 * Three of these are not about them at all — no key, a camera another
 * application is holding, a reading that expired — and reading as though they
 * were would be the app blaming someone for its own setup (KV-7).
 */
const FAILURE: Record<CaptureFailure, { title: string; detail: string }> = {
  'no-api-key': {
    title: 'This app is not set up yet',
    detail:
      'Kinvue has not been given what it needs to use the camera. Nothing is wrong on ' +
      'your side — whoever set this up can finish it.',
  },
  'camera-unavailable': {
    title: 'The camera could not be used',
    detail:
      'Another program may have it open — a video call, perhaps — or it may be the ' +
      'connection. Trying again in a moment is usually enough, and nothing is wrong ' +
      'on your side.',
  },
  'capture-in-progress': {
    // Says what the button does, because the button is the only way out of
    // this state (KV-76). The previous reading is still running, but waiting
    // for it gains nothing — by the time it finishes this screen has moved on
    // and its result is dropped — and this screen offers no way to retry. So
    // "try again in a few seconds" asked for a wait that led nowhere, next to
    // the one control that ends the thing being waited for.
    //
    // "in a moment" is load-bearing and not hedging. Stopping frees the *lock*
    // at once, but `cleanUp` in app/main/vitals.ts tears the device down with
    // an unawaited `stopAsync().then(destroy)`, so pressing Take a reading
    // instantly can still find the camera held and land the person on "another
    // program may have it open" — pointed at a video call that was never the
    // problem, moments after being told a new reading can start. Awaiting the
    // teardown before the lock clears is the real fix (KV-84).
    title: 'The camera is still busy',
    detail:
      'It has not finished with the reading before this one. Going back will stop that ' +
      'reading and release the camera, so a new one can start in a moment.',
  },
  unknown: {
    title: 'The reading could not be taken',
    detail: 'Something went wrong with the camera. Trying again is worth a go.',
  },
}

export default function CaptureScreen({
  failure,
  onCancel,
}: {
  failure: CaptureFailure | null
  onCancel: () => void
}): React.JSX.Element {
  const [elapsedSec, setElapsedSec] = useState(0)
  const [guidance, setGuidance] = useState<string | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const latestUrl = useRef<string | null>(null)
  const previousUrl = useRef<string | null>(null)

  useEffect(() => {
    // Subscriptions only, which are safe to set up and tear down twice.
    const offProgress = window.kinvue.onCaptureProgress(setElapsedSec)
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
      offGuidance()
      offFrame()
      for (const url of [latestUrl.current, previousUrl.current]) {
        if (url !== null) URL.revokeObjectURL(url)
      }
      latestUrl.current = null
      previousUrl.current = null
    }
  }, [])

  const remaining = Math.max(0, CAPTURE_SECONDS - elapsedSec)

  if (failure !== null) {
    const { title, detail } = FAILURE[failure]
    return (
      <section className="mx-auto max-w-xl text-center">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-2 text-base text-(--color-muted)">{detail}</p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-6 rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
        >
          Go back
        </button>
      </section>
    )
  }

  return (
    <section className="mx-auto max-w-xl text-center">
      <h2 className="text-xl font-semibold">Sit comfortably and look at the camera</h2>

      <div className="relative mt-6 overflow-hidden rounded-xl border border-(--color-line) bg-(--color-raised)">
        {previewFailed ? (
          // Said out loud rather than left blank. A picture that silently never
          // arrives is how the first real run looked, and it took a CSP rule to
          // explain: the advice below is what matters, and it still works.
          <p className="px-6 py-16 text-sm text-(--color-muted)">
            The picture is not available on this machine. The advice below still applies.
          </p>
        ) : frameUrl === null ? (
          <p className="px-6 py-16 text-sm text-(--color-muted)">Starting the camera…</p>
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
          being fine, which is constantly while someone is adjusting. */}
      <p aria-live="polite" className="mt-4 min-h-6 text-base">
        {guidance}
      </p>
      {guidance === null && (
        <p className="-mt-6 min-h-6 text-base">Holding still is all that is needed.</p>
      )}

      <p className="mt-2 text-sm text-(--color-muted)">
        {remaining > 0 ? `About ${remaining} seconds left` : 'Finishing up…'}
      </p>

      {/* Stops the camera for real: main abandons the capture and releases the
          device. A button that said Stop and left the camera running for
          another half minute would be the wrong lie on the one screen the
          person being filmed reads. */}
      <button
        type="button"
        onClick={onCancel}
        className="mt-6 text-sm text-(--color-muted) underline hover:text-(--color-ink)"
      >
        Stop
      </button>
    </section>
  )
}
