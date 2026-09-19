import { useEffect, useRef, useState } from 'react'

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
export default function CaptureScreen({
  error,
  onCancel,
}: {
  error: string | null
  onCancel: () => void
}): React.JSX.Element {
  const [elapsedSec, setElapsedSec] = useState(0)
  const [guidance, setGuidance] = useState<string | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const latestUrl = useRef<string | null>(null)

  useEffect(() => {
    // Subscriptions only, which are safe to set up and tear down twice.
    const offProgress = window.kinvue.onCaptureProgress(setElapsedSec)
    const offGuidance = window.kinvue.onCaptureGuidance(setGuidance)
    const offFrame = window.kinvue.onCaptureFrame((jpeg) => {
      // One object URL at a time: the old one is revoked as the new one
      // replaces it, so a 30-second capture does not leak 300 blobs.
      // Copied into a fresh view: the IPC payload is typed over a shared
      // ArrayBufferLike, which Blob will not take directly.
      const url = URL.createObjectURL(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }))
      if (latestUrl.current !== null) URL.revokeObjectURL(latestUrl.current)
      latestUrl.current = url
      setFrameUrl(url)
    })

    return () => {
      offProgress()
      offGuidance()
      offFrame()
      if (latestUrl.current !== null) URL.revokeObjectURL(latestUrl.current)
      latestUrl.current = null
    }
  }, [])

  const remaining = Math.max(0, CAPTURE_SECONDS - elapsedSec)

  if (error !== null) {
    return (
      <section className="mx-auto max-w-xl text-center">
        <h2 className="text-xl font-semibold">The reading could not be taken</h2>
        <p className="mt-2 text-sm text-(--color-muted)">{error}</p>
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
        {frameUrl === null ? (
          <p className="px-6 py-16 text-sm text-(--color-muted)">Starting the camera…</p>
        ) : (
          // Mirrored, so moving left moves the picture left: a self-view that
          // reverses your own movements is harder to frame by, not easier.
          <img src={frameUrl} alt="" className="w-full -scale-x-100" />
        )}
      </div>

      {/* Announced as it changes: the person may be looking at themselves
          rather than at the text, and this is the part worth hearing. */}
      <p aria-live="polite" className="mt-4 min-h-6 text-base">
        {guidance ?? 'Holding still is all that is needed.'}
      </p>

      <p className="mt-2 text-sm text-(--color-muted)">
        {remaining > 0 ? `About ${remaining} seconds left` : 'Finishing up…'}
      </p>

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
