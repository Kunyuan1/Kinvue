import type { SessionRecord } from '@core/session/types'
import { chosenFor, type Removal } from '@core/session/lifecycle'
import ConfirmDeletion from './ConfirmDeletion'

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
 * The buttons, the export and the focus are `ConfirmDeletion`'s, shared with
 * deleting a person.
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
  /** Makes an export first, resolving to what to say, or null (`ConfirmDeletion`). */
  onExport: (passphrase?: string) => Promise<string | null>
  /** Called with how many were deleted, once they are. */
  onDone: (removed: number) => Promise<void>
  onCancel: () => void
  /** A step that failed: the dashboard says so the way it says any other. */
  onFailure: (e: unknown) => void
}) {
  const chosen = chosenFor(sessions, personId, which)
  const last = chosen.at(-1)
  if (last === undefined) return null
  const count = chosen.length === 1 ? 'this check-in' : `${String(chosen.length)} check-ins`
  // A demo day leaves no tombstone, so the note is promised only when a real
  // check-in is going (review of #185) — on a fresh install, none is.
  const leavesANote = chosen.some((r) => r.seeded !== true)

  return (
    <ConfirmDeletion
      heading={
        (which.kind === 'all' ? 'Delete the whole history' : `Delete ${count}`) +
        (chosen.length > 1 ? `, the last taken ${moment(last.capturedAt)}?` : '?')
      }
      deleteLabel="Delete"
      afterNote="An export is a copy to keep: restoring it will not bring these back."
      onDelete={async () => {
        await onDone(await window.kinvue.removeCheckIns(personId, which))
      }}
      onExport={onExport}
      onCancel={onCancel}
      onFailure={onFailure}
    >
      <li>This cannot be undone, not even by restoring an export.</li>
      <li>
        Older cards compared against {chosen.length === 1 ? 'this day' : 'these days'} may
        note that they would read differently now.
      </li>
      {which.kind === 'all' && leavesANote && (
        <li>
          A note of which check-ins were deleted, and when, stays on this computer, so that an
          export made earlier cannot bring them back. It holds no readings and no answers.
        </li>
      )}
      {!leavesANote && <li>These are demo days, so nothing is kept of them.</li>}
    </ConfirmDeletion>
  )
}
