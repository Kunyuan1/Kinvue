import { useId, useState } from 'react'
import type { SessionRecord } from '@core/session/types'
import { chosenFor, type Removal } from '@core/session/lifecycle'

const BUTTON = 'rounded-lg border px-4 py-2 hover:bg-(--color-raised)'

/** A moment on this device, for the confirm screen: "3 October, 23:40". */
const moment = (instant: string): string =>
  new Date(instant).toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  })

/**
 * The step before a deletion (KV-21): what will go, and what deleting means,
 * said before anything goes — ARCHITECTURE.md, "Exporting, deleting, and how
 * long a history is kept".
 *
 * It names how many check-ins and when the last of them was taken; says it
 * cannot be undone, not even by restoring an export, so the export it offers
 * is a copy to keep and not an undo; and says older cards compared against
 * these days may note they would read differently now, so a line appearing on
 * a settled card has been explained before it appears. Deleting everything also
 * says what is kept of it, and why that cannot go.
 *
 * "Keep them" has the focus: the choice that changes nothing is the default.
 */
export default function ConfirmRemoval({
  sessions,
  personId,
  which,
  onExport,
  onDone,
  onCancel,
  onFailure,
}: {
  sessions: readonly SessionRecord[]
  personId: string
  which: Removal
  /** Makes an export, from the screen that offers one first. */
  onExport: () => Promise<void>
  /** Called with how many were deleted, once they are. */
  onDone: (removed: number) => Promise<void>
  onCancel: () => void
  /** A step that failed: the dashboard says so the way it says any other. */
  onFailure: (e: unknown) => void
}) {
  const heading = useId()
  const [busy, setBusy] = useState(false)
  const chosen = chosenFor(sessions, personId, which)
  const last = chosen.at(-1)
  if (last === undefined) return null
  const count = chosen.length === 1 ? 'this check-in' : `${String(chosen.length)} check-ins`

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
        {which.kind === 'all' ? 'Delete the whole history' : `Delete ${count}`}
        {chosen.length > 1 ? `, the last taken ${moment(last.capturedAt)}?` : '?'}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-(--color-muted)">
        <li>This cannot be undone, not even by restoring an export.</li>
        <li>
          Older cards compared against {chosen.length === 1 ? 'this day' : 'these days'} may
          note that they would read differently now.
        </li>
        {which.kind === 'all' && (
          <li>
            A note of which check-ins were deleted, and when, stays on this computer, so that an
            export made earlier cannot bring them back. It holds no readings and no answers.
          </li>
        )}
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
          disabled={busy}
          onClick={() => void run(onExport)}
          className={`${BUTTON} border-(--color-line)`}
        >
          Export first
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await onDone(await window.kinvue.removeCheckIns(personId, which))
            })
          }
          className={`${BUTTON} border-(--color-elevated) text-(--color-elevated)`}
        >
          Delete
        </button>
      </div>
    </div>
  )
}
