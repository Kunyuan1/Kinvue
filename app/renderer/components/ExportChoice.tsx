import { useId, useState } from 'react'
import { MIN_PASSPHRASE_LENGTH } from '@core/session/lifecycle'

const BUTTON = 'rounded-lg border border-(--color-line) px-4 py-2 hover:bg-(--color-raised)'

/**
 * Whether to protect an export with a passphrase (KV-175, T16), asked before
 * the save dialog — from the panel, and from the confirm screen's "Export
 * first", so the copy kept before a deletion can be protected too.
 *
 * It says what each choice costs: a passphrase that is forgotten loses this
 * copy, not the history here; without one, the file is readable by whoever
 * has it. The passphrase is typed twice, and goes to the main process once,
 * to make the file; nothing here keeps it.
 */
export default function ExportChoice({
  onExport,
  onDone,
  onCancel,
}: {
  /** The dashboard's export: resolves to what to say, or null (cancelled, or said). */
  onExport: (passphrase?: string) => Promise<string | null>
  onDone: (said: string | null) => void
  onCancel: () => void
}) {
  const id = useId()
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const short = passphrase !== '' && passphrase.length < MIN_PASSPHRASE_LENGTH
  const differ = again !== '' && again !== passphrase
  const ready = passphrase.length >= MIN_PASSPHRASE_LENGTH && again === passphrase

  const run = async (secret?: string): Promise<void> => {
    setBusy(true)
    try {
      onDone(await onExport(secret))
    } finally {
      setBusy(false)
      setPassphrase('')
      setAgain('')
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={`${id}-heading`}
      className="mt-3 rounded-lg border border-(--color-line) p-4 text-sm"
    >
      <p id={`${id}-heading`} className="font-medium">
        Protect this file with a passphrase?
      </p>
      <p className="mt-1 text-(--color-muted)">
        With one, the file opens only with it. Forget it, and this copy cannot be opened; the
        history here is not affected. Without one, anyone who has the file can read it.
      </p>
      <div className="mt-3 grid max-w-sm gap-2">
        <label htmlFor={`${id}-passphrase`}>Passphrase</label>
        <input
          id={`${id}-passphrase`}
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="rounded-lg border border-(--color-line) bg-transparent px-2 py-1"
        />
        <label htmlFor={`${id}-again`}>The same passphrase again</label>
        <input
          id={`${id}-again`}
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          className="rounded-lg border border-(--color-line) bg-transparent px-2 py-1"
        />
      </div>
      <p aria-live="polite" className="mt-2 min-h-5 text-(--color-elevated)">
        {short
          ? `A passphrase needs at least ${String(MIN_PASSPHRASE_LENGTH)} characters.`
          : differ
            ? 'The two passphrases do not match.'
            : null}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() => void run(passphrase)}
          className={BUTTON}
        >
          Export with this passphrase&hellip;
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          className={BUTTON}
        >
          Export without one&hellip;
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  )
}
