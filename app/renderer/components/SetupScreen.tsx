import { useState } from 'react'
import type { CameraAccess } from '../../shared/camera-access'

const BUTTON =
  'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/** The camera switches that keep a reading from running, as the setup screen says them. */
export type CameraOff = Exclude<CameraAccess, 'allowed' | 'unknown'>

/** Whether `access` keeps a reading from running. */
export const cameraIsOff = (access: CameraAccess | undefined): access is CameraOff =>
  access !== undefined && access !== 'allowed' && access !== 'unknown'

/** Which switch, and where it is: Windows's own words for it, so it can be found. */
const SAYS: Record<CameraOff, string> = {
  'off-for-desktop-apps':
    'Windows is keeping desktop apps away from the camera, so Kinvue cannot take a reading ' +
    'yet. In Settings, under Privacy & security, then Camera, turn on “Let desktop apps ' +
    'access your camera”.',
  'off-for-apps':
    'Windows is keeping apps away from the camera, so Kinvue cannot take a reading yet. In ' +
    'Settings, under Privacy & security, then Camera, turn on “Let apps access your camera”, ' +
    'and then “Let desktop apps access your camera” below it.',
  'off-for-kinvue':
    'Windows has been set to keep Kinvue itself away from the camera, so it cannot take a ' +
    'reading yet. There is no switch for this in Settings: it is set for this computer, ' +
    'and whoever looks after it can lift it.',
  'off-for-this-computer':
    'The camera is turned off for this whole computer, so Kinvue cannot take a reading yet. ' +
    'In Settings, under Privacy & security, then Camera, turn on “Camera access”. That may ' +
    'need whoever looks after this computer.',
}

/**
 * The first-run screen (KV-19): what has to be set before the first reading,
 * said before anyone sits down to a capture that cannot run, not after it
 * fails. Today that is Windows's camera switches; the household's own key joins
 * it next (#19).
 *
 * Shown whenever a switch is off, not only on the first run — a switch turned
 * off later stops a reading just the same. The check-ins can still be read
 * without the camera, so the way past it is always there.
 */
export default function SetupScreen({
  access,
  onCheckAgain,
  onContinue,
}: {
  access: CameraOff
  /** Asks Windows again; resolves to what it says now. */
  onCheckAgain: () => Promise<CameraAccess>
  /** To the check-ins, the camera still off. */
  onContinue: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const checkAgain = async (): Promise<void> => {
    setBusy(true)
    setSaid(null)
    try {
      // Allowed now: the dashboard takes over and this screen goes. Still off:
      // say so, or a press that changes nothing looks like a press not taken.
      if (cameraIsOff(await onCheckAgain())) setSaid('The camera is still turned off.')
    } catch {
      setSaid('Windows could not be asked just now. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Before the first reading</h1>
      <p className="mt-4 text-base leading-relaxed">{SAYS[access]}</p>
      <p className="mt-3 text-sm text-(--color-muted)">
        Kinvue reads the camera itself, so Windows asks nothing when a reading starts: this
        switch is the only place to allow it.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={() => {
            void window.kinvue.openCameraSettings().catch((e: unknown) => {
              console.error('Could not open the camera settings.', e)
              setSaid('The settings could not be opened. Open them from the Start menu instead.')
            })
          }}
          className={BUTTON}
        >
          Open camera settings
        </button>
        <button type="button" disabled={busy} onClick={() => void checkAgain()} className={BUTTON}>
          Check again
        </button>
        <button type="button" disabled={busy} onClick={onContinue} className={BUTTON}>
          Go to the check-ins
        </button>
      </div>
      {/* Always there, as the other screens' are: a region created with its
          text is announced unreliably. */}
      <p aria-live="polite" className="mt-4 min-h-5 text-sm text-(--color-muted)">
        {said}
      </p>
    </main>
  )
}
