import { useId, useState } from 'react'
import type { KeyStatus } from '../../shared/api-key'

const BUTTON =
  'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/**
 * What a key just kept means, said once it is: where it is and how it is kept.
 * Total over `KeyStatus`, with null where keeping a key cannot end, so a new
 * status does not compile until it is decided here (review of #195).
 */
export const KEPT: Record<KeyStatus, string | null> = {
  saved: "Saved, encrypted with this computer's key.",
  held:
    "Saved for now. It is stored encrypted in a moment, once this computer's key is ready; " +
    'if Kinvue is closed before then, it will ask for the key again.',
  'saved-plain': 'Saved, but not encrypted: this computer offers no key store.',
  none: null,
  lost: null,
  locked: null,
  environment: null,
  unknown: null,
}

/**
 * The household's SmartSpectra key, typed in (KV-19): on the first-run screen,
 * and on the dashboard to replace it. A password field, so it is not read off
 * the screen over a shoulder, and never filled back in: main is not asked for
 * the key, and does not give it.
 *
 * Checked in main, which says whether it was kept; the line under the field
 * says what that means. The field empties once a key is kept, and keeps what
 * was typed when it is refused, so it can be corrected.
 */
export default function KeyField({
  label,
  onKept,
  autoFocus = false,
}: {
  label: string
  /** Once a key is kept: where it stands now. */
  onKept: (status: KeyStatus) => void
  autoFocus?: boolean
}) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setSaid(null)
    try {
      const result = await window.kinvue.setApiKey(typed)
      if (!result.ok) {
        setSaid(
          result.why === 'locked'
            ? "This computer's key store is not available just now, so the saved key is left " +
                'as it is. Kinvue will try again the next time it starts.'
            : 'That does not look like a SmartSpectra key. Copy it again from the SmartSpectra ' +
                'page, with nothing before or after it.',
        )
        return
      }
      setTyped('')
      setSaid(KEPT[result.status])
      onKept(result.status)
    } catch (e) {
      console.error('Could not keep the key.', e)
      setSaid('The key could not be saved. Nothing has been changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      {/* A form, so Enter after a paste saves, as it does everywhere else
          (review of #195); the button's own guard decides whether it can. */}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && typed.trim() !== '') void save()
        }}
      >
        <label htmlFor={`${id}-key`}>{label}</label>
        <input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="min-w-64 rounded-lg border border-(--color-line) bg-transparent px-2 py-1"
        />
        <button type="submit" disabled={busy || typed.trim() === ''} className={BUTTON}>
          Save the key
        </button>
      </form>
      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-(--color-muted)">
        {said}
      </p>
    </div>
  )
}
