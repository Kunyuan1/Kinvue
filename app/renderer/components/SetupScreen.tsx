import { useState } from 'react'
import type { CameraAccess } from '../../shared/camera-access'
import { keyMissing, type KeyStatus } from '../../shared/api-key'
import ForgetKey from './ForgetKey'
import KeyField from './KeyField'
import NameField from './NameField'
import type { PersonShown } from '../../shared/people'
import { useFocusWhenShown } from './person'

const BUTTON =
  'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/** The camera switches that keep a reading from running, as the setup screen says them. */
export type CameraOff = Exclude<CameraAccess, 'allowed' | 'unknown'>

/** Whether `access` keeps a reading from running. */
export const cameraIsOff = (access: CameraAccess | undefined): access is CameraOff =>
  access !== undefined && access !== 'allowed' && access !== 'unknown'

/**
 * Whether the setup screen has anything to ask for: the camera, the key, or
 * whose the check-ins are (KV-18).
 */
export const setupNeeded = (camera: CameraAccess, key: KeyStatus, nameNeeded: boolean): boolean =>
  cameraIsOff(camera) || keyMissing(key) || nameNeeded

/**
 * Why a name is asked for (KV-18). A history from before KV-18 is someone's
 * already, under the demo's old name; a new computer has nobody yet.
 */
const NAME_SAYS = {
  before:
    'The check-ins already on this computer were taken before Kinvue asked whose they are. ' +
    'Give the name of the person they belong to. It is shown on their check-ins, and kept ' +
    'on this computer only.',
  first:
    'The name of the person who will take the readings. It is shown on their check-ins, and ' +
    'kept on this computer only.',
}

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
 * Why the key is asked for, or why it cannot be, by where it stands. Total, with
 * null where the screen does not ask, so a new status is decided here.
 */
const KEY_SAYS: Record<KeyStatus, string | null> = {
  none:
    'Kinvue needs a key from SmartSpectra, the service that reads the camera, to take a ' +
    'reading. It is free: register, copy the key from the page you are given, and paste it ' +
    'here. It is kept on this computer, encrypted, and never shown again.',
  lost:
    "The key saved here could not be opened with this account's key — it may have been " +
    'saved under another account or computer, or before a password reset. Enter it again, ' +
    'and it replaces the old one.',
  locked:
    "A key is saved, but this computer's key store is not available just now — it may be " +
    'locked. Kinvue will try again the next time it starts; nothing has been changed. If ' +
    'this keeps happening, forget the saved key and enter it again.',
  held: null,
  saved: null,
  'saved-plain': null,
  environment: null,
  unknown: null,
}

/**
 * The first-run screen (KV-19): what has to be set before the first reading,
 * said before anyone sits down to a capture that cannot run, not after it
 * fails — Windows's camera switches, and the household's own SmartSpectra key.
 *
 * Shown whenever either is missing, not only on the first run — a switch turned
 * off later stops a reading just the same. The check-ins can still be read
 * without either, so the way past it is always there.
 */
export default function SetupScreen({
  camera,
  keyStatus,
  nameNeeded,
  unnamed,
  firstReading,
  onCheckAgain,
  onKeyKept,
  onNamed,
  onContinue,
}: {
  camera: CameraAccess
  keyStatus: KeyStatus
  /** Nobody is named yet: whose the check-ins are is asked for. */
  nameNeeded: boolean
  /** The person to name, when their check-ins are here already; null to add the first. */
  unnamed: PersonShown | null
  /**
   * No reading has been taken here yet. Otherwise the heading says the next
   * one: a history with months in it, told *before the first reading*, read as
   * though it were gone (review of #200).
   */
  firstReading: boolean
  /** A name was kept. */
  onNamed: (person: PersonShown) => void
  /** Asks Windows again; resolves to what it says now. */
  onCheckAgain: () => Promise<CameraAccess>
  /** A key was kept: where it stands now. */
  onKeyKept: (status: KeyStatus) => void
  /** To the check-ins, with what is missing still missing. */
  onContinue: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const askCamera = cameraIsOff(camera)
  const askKey = keyMissing(keyStatus)
  // Focused as it opens (KV-20): Take a reading can lead here, and the button
  // pressed is gone with the dashboard (review of #196). The heading, not the
  // first control: a screen reader reads what is missing before the control
  // that fixes it, one Tab away. So nothing here takes `autoFocus`. It no
  // longer races the heading — the hook's layout effect runs after it and
  // wins — but it would focus a control first, inside the same commit, and a
  // screen reader can announce that before the heading (review of #202). A
  // test watches every focus as the screen opens.
  const heading = useFocusWhenShown<HTMLHeadingElement>()

  const checkAgain = async (): Promise<void> => {
    setBusy(true)
    setSaid(null)
    try {
      // Allowed now: the section goes. Still off: say so, or a press that
      // changes nothing looks like a press not taken.
      if (cameraIsOff(await onCheckAgain())) setSaid('The camera is still turned off.')
    } catch {
      setSaid('Windows could not be asked just now. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const openLink = (open: () => Promise<void>, instead: string): void => {
    void open().catch((e: unknown) => {
      console.error('Could not open the link.', e)
      setSaid(instead)
    })
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">
        {firstReading ? 'Before the first reading' : 'Before the next reading'}
      </h1>

      {askCamera && (
        <section aria-labelledby="setup-camera" className="mt-6">
          <h2 id="setup-camera" className="text-lg font-medium">
            The camera
          </h2>
          <p className="mt-2 text-base leading-relaxed">{SAYS[camera]}</p>
          <p className="mt-2 text-sm text-(--color-muted)">
            Kinvue reads the camera itself, so Windows asks nothing when a reading starts: this
            switch is the only place to allow it.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                openLink(
                  () => window.kinvue.openCameraSettings(),
                  'The settings could not be opened. Open them from the Start menu instead.',
                )
              }
              className={BUTTON}
            >
              Open camera settings
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void checkAgain()}
              className={BUTTON}
            >
              Check again
            </button>
          </div>
        </section>
      )}

      {askKey && (
        <section aria-labelledby="setup-key" className="mt-8">
          <h2 id="setup-key" className="text-lg font-medium">
            The SmartSpectra key
          </h2>
          <p className="mt-2 text-base leading-relaxed">{KEY_SAYS[keyStatus]}</p>
          {keyStatus === 'locked' && <ForgetKey onForgot={onKeyKept} />}
          {keyStatus !== 'locked' && (
            <>
              {/* The field first, then the way to a key: one Tab from the
                  heading is where a copied key is pasted, not a button that
                  leaves for the browser (review of #202). */}
              <KeyField label="Key" onKept={onKeyKept} />
              <button
                type="button"
                onClick={() =>
                  openLink(
                    () => window.kinvue.openKeyRegistration(),
                    'The page could not be opened. It is physiology.presagetech.com.',
                  )
                }
                className={`mt-3 ${BUTTON}`}
              >
                Get a free key
              </button>
            </>
          )}
        </section>
      )}

      {nameNeeded && (
        <section aria-labelledby="setup-name" className="mt-8">
          <h2 id="setup-name" className="text-lg font-medium">
            Whose check-ins
          </h2>
          <p className="mt-2 text-base leading-relaxed">
            {unnamed !== null ? NAME_SAYS.before : NAME_SAYS.first}
          </p>
          <NameField
            label="Name"
            autoFocus={!askCamera && !askKey}
            save={(name) =>
              unnamed !== null
                ? window.kinvue.renamePerson(unnamed.id, name)
                : window.kinvue.addPerson(name)
            }
            onNamed={onNamed}
          />
        </section>
      )}

      <div className="mt-8">
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
