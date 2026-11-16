import { useId, useState } from 'react'
import ExportChoice from './ExportChoice'

// Dimmed, with no hover, when disabled (KV-175): a guard that looks live is no guard.
const BUTTON = 'rounded-lg border px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The step before any deletion (KV-21, KV-18): what goes, said before it goes,
 * with the export offered first and the choice that changes nothing focused.
 * One shell for deleting check-ins (`ConfirmRemoval`) and deleting a person
 * (`ConfirmPersonRemoval`), which differ only in what they say: a change to how
 * a deletion is confirmed reaches both, rather than one (review of #206).
 *
 * "Keep them" has the focus: the choice that changes nothing is the default.
 */
export default function ConfirmDeletion<Deleted>({
  heading,
  children,
  deleteLabel,
  canExport = true,
  afterNote,
  onDelete,
  onDeleted,
  onExport,
  onCancel,
  onFailure,
}: {
  /** The question, read as the group's name. */
  heading: string
  /** What deleting means here, as list items. */
  children: React.ReactNode
  deleteLabel: string
  /** False when there is nothing to export. */
  canExport?: boolean
  /** Said under the buttons, beside the export it offers, so it is not read as an undo. */
  afterNote: string
  /** Deletes, and nothing else: a throw is `onFailure`'s, and means nothing went. */
  onDelete: () => Promise<Deleted>
  /**
   * What follows a deletion that landed, given what `onDelete` resolved to.
   * Called outside `onFailure`'s reach (KV-235): by now the deletion cannot be
   * undone, so nothing that goes wrong after it — a reload, most of all — can
   * be said as the deletion failing. It answers for its own failures.
   */
  onDeleted: (deleted: Deleted) => void
  /**
   * Makes an export, from the screen that offers one first: the dashboard's
   * one export, resolving to what to say, shown here beside the Delete it
   * precedes (review of #185), or null when there is nothing to say.
   */
  onExport: (passphrase?: string) => Promise<string | null>
  onCancel: () => void
  /** A step that failed: the dashboard says so the way it says any other. */
  onFailure: (e: unknown) => void
}) {
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  // "Export first" asks the same question the panel does (KV-175).
  const [choosing, setChoosing] = useState(false)

  const remove = async (): Promise<void> => {
    setBusy(true)
    let deleted: Deleted
    try {
      deleted = await onDelete()
    } catch (e) {
      onFailure(e)
      return
    } finally {
      setBusy(false)
    }
    // Not in the `try` above, on purpose: see `onDeleted`.
    try {
      onDeleted(deleted)
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={id}
      className="mt-3 rounded-lg border border-(--color-line) p-4 text-sm"
    >
      <p id={id} className="font-medium">
        {heading}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-(--color-muted)">{children}</ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
          className={`${BUTTON} border-(--color-line)`}
        >
          Keep them
        </button>
        <button
          type="button"
          disabled={busy || choosing || !canExport}
          onClick={() => setChoosing(true)}
          className={`${BUTTON} border-(--color-line)`}
        >
          Export first
        </button>
        {/* Not while "Export first" is unfinished (review of #187): the copy it
            is making is the safeguard, and Delete must not cut it short. */}
        <button
          type="button"
          disabled={busy || choosing}
          onClick={() => void remove()}
          className={`${BUTTON} border-(--color-elevated) text-(--color-elevated)`}
        >
          {deleteLabel}
        </button>
      </div>
      {choosing && (
        <ExportChoice
          onExport={onExport}
          onCancel={() => setChoosing(false)}
          onDone={(said) => {
            setChoosing(false)
            setExported(said)
          }}
        />
      )}
      {/* Said on the screen, not only in ARCHITECTURE.md (review of #185): beside
          "not even by restoring an export", the offer would read as an undo. */}
      <p className="mt-2 text-xs text-(--color-muted)">{afterNote}</p>
      {/* Always there, so what an export says is announced when it arrives. */}
      <p aria-live="polite" className="mt-2 min-h-5 text-(--color-muted)">
        {exported}
      </p>
    </div>
  )
}
