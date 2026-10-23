import { useId, useState } from 'react'
import ExportChoice from './ExportChoice'

// Dimmed, with no hover, when disabled (KV-175): a guard that looks live is no guard.
const BUTTON = 'rounded-lg border px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The step before deleting a person (KV-18): who goes, with how many check-ins,
 * and what deleting a person means, said before anything goes — as
 * `ConfirmRemoval` says it for check-ins (KV-21).
 *
 * It cannot be undone, not even by restoring an export, so the export it offers
 * is a copy to keep and not an undo. What stays is said too: a note of their
 * key and when, with no name and nothing of their check-ins, which is what keeps
 * an export made earlier from bringing them back.
 *
 * "Keep them" has the focus: the choice that changes nothing is the default.
 */
export default function ConfirmPersonRemoval({
  person,
  checkIns,
  onExport,
  onDone,
  onCancel,
  onFailure,
}: {
  person: { id: string; name: string }
  /** How many of their check-ins are here, for the sentence. */
  checkIns: number
  /** Makes an export of their history first, resolving to what to say, or null. */
  onExport: (passphrase?: string) => Promise<string | null>
  /** Called with how many check-ins went, once they have. */
  onDone: (removed: number) => Promise<void>
  onCancel: () => void
  /** A step that failed: the dashboard says so the way it says any other. */
  onFailure: (e: unknown) => void
}) {
  const heading = useId()
  const [busy, setBusy] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const theirs =
    checkIns === 0
      ? 'They have no check-ins here'
      : checkIns === 1
        ? 'Their one check-in goes with them'
        : `All ${String(checkIns)} of their check-ins go with them`

  const run = async (step: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await step()
    } catch (e) {
      onFailure(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={heading}
      className="mt-3 rounded-lg border border-(--color-line) p-4 text-sm"
    >
      <p id={heading} className="font-medium">
        Delete {person.name} from this computer?
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-(--color-muted)">
        <li>{theirs}, and so does their name.</li>
        <li>This cannot be undone, not even by restoring an export.</li>
        <li>
          A note that someone was deleted, and when, stays on this computer, so that an export
          made earlier cannot bring them back. It holds no name, no readings and no answers.
        </li>
      </ul>
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
          disabled={busy || choosing || checkIns === 0}
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
          onClick={() =>
            void run(async () => {
              await onDone(await window.kinvue.removePerson(person.id))
            })
          }
          className={`${BUTTON} border-(--color-elevated) text-(--color-elevated)`}
        >
          Delete {person.name}
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
      <p className="mt-2 text-xs text-(--color-muted)">
        An export is a copy to keep: restoring it will not bring them back.
      </p>
      {/* Always there, so what an export says is announced when it arrives. */}
      <p aria-live="polite" className="mt-2 min-h-5 text-(--color-muted)">
        {exported}
      </p>
    </div>
  )
}
