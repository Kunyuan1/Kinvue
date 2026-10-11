import { useState } from 'react'
import type { KeyStatus } from '../../shared/api-key'
import KeyField, { KEPT } from './KeyField'

const BUTTON =
  'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The household's SmartSpectra key, at the foot of the dashboard (KV-19):
 * where it stands, and a way to replace it. Never the key itself.
 *
 * After a reading the service would not accept, it says the key may be the
 * cause and offers the replacement here — the one place it can be fixed. The
 * capture screen, read by the person being measured, only says that whoever
 * set Kinvue up can check it (review of #192).
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
  const line =
    status === 'environment'
      ? 'Taken from SMARTSPECTRA_API_KEY: this is a development build.'
      : (KEPT[status] ?? null)

  return (
    <section
      aria-labelledby="key-heading"
      className="mt-10 border-t border-(--color-line) pt-6 text-sm"
    >
      <h2 id="key-heading" className="text-base font-semibold">
        The SmartSpectra key
      </h2>
      {line !== null && <p className="mt-2 text-(--color-muted)">{line}</p>}
      {suspect && (
        <p className="mt-2 text-(--color-elevated)">
          The last reading was not accepted by the service. If it happens again, the key may
          be wrong or used up, and replacing it here is the fix.
        </p>
      )}
      {status !== 'environment' &&
        (replacing ? (
          <>
            <KeyField
              label="New key"
              autoFocus
              onKept={(next) => {
                setReplacing(false)
                onKept(next)
              }}
            />
            <button type="button" onClick={() => setReplacing(false)} className={BUTTON}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setReplacing(true)} className={`mt-3 ${BUTTON}`}>
            Replace the key&hellip;
          </button>
        ))}
    </section>
  )
}
