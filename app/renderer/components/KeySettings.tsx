import { useState } from 'react'
import type { KeyStatus } from '../../shared/api-key'
import ForgetKey from './ForgetKey'
import KeyField, { KEPT } from './KeyField'

const BUTTON =
  'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Where the key stands, said on the dashboard. Total over `KeyStatus` (review of
 * #195): silent for the states that most need explaining was the bug, so a new
 * status does not compile until it has words here.
 */
const LINE: Record<KeyStatus, string> = {
  saved: KEPT.saved!,
  held: KEPT.held!,
  'saved-plain': KEPT['saved-plain']!,
  environment: 'Taken from SMARTSPECTRA_API_KEY: this is a development build.',
  none: 'No key yet, so no reading can be taken. Enter one below.',
  lost:
    "The saved key could not be opened with this account's key. Enter it again below, and " +
    'it replaces the old one.',
  locked:
    "A key is saved, but this computer's key store is not available just now — it may be " +
    'locked. Kinvue will try again the next time it starts. If this keeps happening, forget ' +
    'the saved key and enter it again.',
  unknown: 'Where the key stands could not be read just now.',
}

/**
 * The household's SmartSpectra key, at the foot of the dashboard (KV-19):
 * where it stands, and a way to enter or replace it. Never the key itself.
 *
 * After a reading the service would not accept, it says the key may be the
 * cause and offers the replacement here — the one place it can be fixed. The
 * capture screen, read by the person being measured, only says that whoever
 * set Kinvue up can check it (review of #192).
 *
 * While the key store is locked it offers no field — `set` refuses there, to
 * keep a good key from being replaced unseen — and offers forgetting the saved
 * key instead (review of #195).
 */
export default function KeySettings({
  status,
  suspect,
  onKept,
}: {
  status: KeyStatus
  /** The last reading was refused by the service, or its key was. */
  suspect: boolean
  onKept: (status: KeyStatus) => void
}) {
  const [replacing, setReplacing] = useState(false)
  const enter = status === 'none' || status === 'lost'

  return (
    <section
      aria-labelledby="key-heading"
      className="mt-10 border-t border-(--color-line) pt-6 text-sm"
    >
      <h2 id="key-heading" className="text-base font-semibold">
        The SmartSpectra key
      </h2>
      <p className="mt-2 text-(--color-muted)">{LINE[status]}</p>
      {suspect && (
        <p className="mt-2 text-(--color-elevated)">
          The last reading was not accepted by the service. If it happens again, the key may be
          wrong or used up, and replacing it here is the fix.
        </p>
      )}
      {status === 'locked' && <ForgetKey onForgot={onKept} />}
      {status !== 'environment' &&
        status !== 'locked' &&
        (replacing || enter ? (
          <>
            <KeyField
              label={enter ? 'Key' : 'New key'}
              autoFocus={replacing}
              onKept={(next) => {
                setReplacing(false)
                onKept(next)
              }}
            />
            {replacing && (
              <button type="button" onClick={() => setReplacing(false)} className={BUTTON}>
                Cancel
              </button>
            )}
          </>
        ) : (
          <button type="button" onClick={() => setReplacing(true)} className={`mt-3 ${BUTTON}`}>
            Replace the key&hellip;
          </button>
        ))}
    </section>
  )
}
