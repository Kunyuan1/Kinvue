import { useState } from 'react'
import type { KeyStatus } from '../../shared/api-key'

const BUTTON =
  'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The way out of a key store that stays locked (KV-19, review of #195): the
 * saved key deleted, so it can be entered again. Asked twice, as a deletion
 * is everywhere else in Kinvue, with "keep it" first — a store that is only
 * locked for now would open the saved key at the next start, and this throws
 * that key away. It is a paste away, which is why it is offered at all.
 */
export default function ForgetKey({ onForgot }: { onForgot: (status: KeyStatus) => void }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const forget = async (): Promise<void> => {
    setBusy(true)
    setSaid(null)
    try {
      onForgot(await window.kinvue.forgetApiKey())
    } catch (e) {
      console.error('Could not forget the saved key.', e)
      setSaid('The saved key could not be removed. Nothing has been changed.')
    } finally {
      setBusy(false)
      setAsking(false)
    }
  }

  return (
    <div className="mt-3">
      {asking ? (
        <div
          role="group"
          aria-label="Forget the saved key"
          className="flex flex-wrap items-center gap-2"
        >
          <span>
            This deletes the saved key from this computer. You will need to paste it in again.
          </span>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={() => setAsking(false)}
            className={BUTTON}
          >
            Keep it
          </button>
          <button type="button" disabled={busy} onClick={() => void forget()} className={BUTTON}>
            Forget it
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setAsking(true)} className={BUTTON}>
          Forget the saved key and enter it again&hellip;
        </button>
      )}
      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-(--color-muted)">
        {said}
      </p>
    </div>
  )
}
