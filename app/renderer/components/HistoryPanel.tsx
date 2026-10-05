import { useState } from 'react'
import type { SessionRecord } from '@core/session/types'
import {
  chosenFor,
  describeLastExport,
  describeRefusal,
  describeRestore,
  type Removal,
} from '@core/session/lifecycle'
import ConfirmRemoval from './ConfirmRemoval'

const BUTTON = 'rounded-lg border border-(--color-line) px-4 py-2 hover:bg-(--color-raised)'

/**
 * A day on this device: "3 October". Exports and deletions happen here, not
 * where a check-in did.
 */
export const deviceDay = (instant: string): string =>
  new Date(instant).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })

/**
 * Export, restore and delete (KV-21), at the foot of the dashboard. Shown even
 * with no check-ins: restoring onto a new device starts from an empty history.
 *
 * The export line says when the last one was made and how many check-ins have
 * come since, so how much a dead device would take is visible without a prompt
 * or a schedule. The note beside it says what the file is: the whole history,
 * pain notes included, unprotected wherever it is put (T16).
 */
export default function HistoryPanel({
  personId,
  sessions,
  lastExported,
  onExport,
  onChanged,
  onFailure,
}: {
  personId: string
  sessions: readonly SessionRecord[]
  /** When the last export was made, null for never, undefined until known. */
  lastExported: string | null | undefined
  /**
   * The dashboard's one export, shared with the confirm screen (review of
   * #185): it refreshes `lastExported` whichever button made it, and resolves
   * to what to say, or null when the person cancelled or it failed (said).
   */
  onExport: () => Promise<string | null>
  /** After a restore or a deletion: reloads the list. */
  onChanged: () => Promise<void>
  onFailure: (e: unknown, fallback: string) => void
}) {
  const [said, setSaid] = useState<string | null>(null)
  const [before, setBefore] = useState('')
  const [removing, setRemoving] = useState<Removal | null>(null)
  const [busy, setBusy] = useState(false)
  const real = sessions.filter((r) => r.seeded !== true)

  const exportHistory = async (): Promise<void> => {
    const exported = await onExport()
    if (exported !== null) setSaid(exported)
  }

  const step = async (run: () => Promise<void>, fallback: string): Promise<void> => {
    setBusy(true)
    try {
      await run()
    } catch (e) {
      onFailure(e, fallback)
    } finally {
      setBusy(false)
    }
  }

  const restore = (): Promise<void> =>
    step(async () => {
      const result = await window.kinvue.restoreHistory(personId)
      if (result === null) return
      if (!result.ok) {
        setSaid(describeRefusal(result.refusal))
        return
      }
      await onChanged()
      setSaid(describeRestore(result.outcome, deviceDay))
    }, 'The file could not be restored. Nothing has been changed.')

  const reviewBefore = (): void => {
    setSaid(null)
    // Midnight at the start of the chosen date, in this device's zone (KV-21).
    const instant = new Date(`${before}T00:00:00`)
    if (before === '' || Number.isNaN(instant.getTime())) return
    const which: Removal = { kind: 'before', before: instant.toISOString() }
    if (chosenFor(sessions, personId, which).length === 0) {
      setSaid('No check-ins were taken before that date.')
      return
    }
    setRemoving(which)
  }

  return (
    <section
      aria-labelledby="history-heading"
      className="mt-10 border-t border-(--color-line) pt-6 text-sm"
    >
      <h2 id="history-heading" className="text-base font-semibold">
        Your history
      </h2>

      <div className="mt-4">
        <button
          type="button"
          disabled={busy || real.length === 0}
          onClick={() => void step(exportHistory, 'The history could not be exported.')}
          className={BUTTON}
        >
          Export history&hellip;
        </button>
        <p className="mt-2 text-(--color-muted)">
          {sessions.length === 0
            ? 'Nothing to export yet.'
            : real.length === 0
              ? 'Nothing to export yet: demo days are not exported.'
              : lastExported === undefined
              ? null
              : describeLastExport(lastExported, sessions, deviceDay)}
        </p>
        <p className="mt-1 text-(--color-muted)">
          The file holds every check-in, pain notes included, and is not protected. Keep it as
          carefully as this computer.
        </p>
      </div>

      <div className="mt-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => void restore()}
          className={BUTTON}
        >
          Restore from an export&hellip;
        </button>
      </div>

      {sessions.length > 0 && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="delete-before">Delete check-ins taken before</label>
            <input
              id="delete-before"
              type="date"
              value={before}
              onChange={(e) => setBefore(e.target.value)}
              className="rounded-lg border border-(--color-line) bg-transparent px-2 py-1"
            />
            <button
              type="button"
              disabled={busy || before === ''}
              onClick={reviewBefore}
              className={BUTTON}
            >
              Review
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setSaid(null)
              setRemoving({ kind: 'all' })
            }}
            className={`mt-3 ${BUTTON}`}
          >
            Delete the whole history&hellip;
          </button>
        </div>
      )}

      {removing !== null && (
        <ConfirmRemoval
          sessions={sessions}
          personId={personId}
          which={removing}
          onExport={onExport}
          onCancel={() => setRemoving(null)}
          onFailure={(e) =>
            onFailure(e, 'The check-ins could not be deleted. Nothing has been changed.')
          }
          onDone={async (removed) => {
            setRemoving(null)
            await onChanged()
            setSaid(`Deleted ${String(removed)} check-in${removed === 1 ? '' : 's'}.`)
          }}
        />
      )}

      {/* Always there, as `CaptureScreen`'s is: a region created with its text
          is announced unreliably, and this says what a deletion or restore did. */}
      <p aria-live="polite" className="mt-4 min-h-5 text-(--color-muted)">
        {said}
      </p>
    </section>
  )
}
