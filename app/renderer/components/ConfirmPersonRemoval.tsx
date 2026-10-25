import ConfirmDeletion from './ConfirmDeletion'

/**
 * The step before deleting a person (KV-18): who goes, with how many check-ins,
 * and what deleting a person means, said before anything goes — as
 * `ConfirmRemoval` says it for check-ins (KV-21), in the same shell.
 *
 * It cannot be undone, not even by restoring an export, so the export it offers
 * is a copy to keep and not an undo. What stays is said too: a note of their
 * key and when, with no name and nothing of their check-ins, which is what keeps
 * an export made earlier from bringing them back.
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
  const theirs =
    checkIns === 0
      ? 'They have no check-ins here'
      : checkIns === 1
        ? 'Their one check-in goes with them'
        : `All ${String(checkIns)} of their check-ins go with them`

  return (
    <ConfirmDeletion
      heading={`Delete ${person.name} from this computer?`}
      deleteLabel={`Delete ${person.name}`}
      // Nothing of theirs to export.
      canExport={checkIns > 0}
      afterNote="An export is a copy to keep: restoring it will not bring them back."
      onDelete={async () => {
        await onDone(await window.kinvue.removePerson(person.id))
      }}
      onExport={onExport}
      onCancel={onCancel}
      onFailure={onFailure}
    >
      <li>{theirs}, and so does their name.</li>
      <li>This cannot be undone, not even by restoring an export.</li>
      <li>
        A note that someone was deleted, and when, stays on this computer, so that an export
        made earlier cannot bring them back. It holds no name, no readings and no answers.
      </li>
    </ConfirmDeletion>
  )
}
