import { useState } from 'react'
import type { SessionRecord } from '@core/session/types'
import {
  chosenFor,
  describeLastExport,
  describeRefusal,
  describeRestore,
  type Removal,
} from '@core/session/lifecycle'
import type { Protection } from '../../shared/protection'
import ConfirmRemoval from './ConfirmRemoval'
import ExportChoice from './ExportChoice'

const BUTTON = 'rounded-lg border border-(--color-line) px-4 py-2 hover:bg-(--color-raised)'

/** What each state says, including what encryption here does not cover. */
const PROTECTION: Record<Protection, string> = {
  encrypted:
    "Kept encrypted with this computer's key for this account. Anyone signed in as this " +
    'account can still open it.',
  'not-yet-encrypted':
    "Encryption with this computer's key is being set up. Until it is, the history is kept " +
    'as it was, unencrypted.',
  'no-key-store': 'This computer offers no key store, so the history here is not encrypted.',
}

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
 * or a schedule. Exporting asks first whether to protect the file with a
 * passphrase (KV-175, T16); without one it is the whole history, pain notes
 * included, readable wherever it is put, and the note beside it says so.
 *
 * It also says whether the history here is encrypted with this computer's key
 * (KV-175), and what that does not cover — or that it is not encrypted, where
 * the computer offers no key store.
 */
export default function HistoryPanel({
  personId,
  sessions,
  lastExported,
  protection,
  onExport,
  onChanged,
  onFailure,
}: {
  personId: string
  sessions: readonly SessionRecord[]
  /** When the last export was made, null for never, undefined until known. */
  lastExported: string | null | undefined
  /** Where the history's protection stands; undefined until known. */
  protection: Protection | undefined
  /**
   * The dashboard's one export, shared with the confirm screen (review of
   * #185): it refreshes `lastExported` whichever button made it, and resolves
   * to what to say, or null when the person cancelled or it failed (said).
   * Protected with `passphrase` when one is given (KV-175).
   */
  onExport: (passphrase?: string) => Promise<string | null>
  /** After a restore or a deletion: reloads the list. */
  onChanged: () => Promise<void>
  onFailure: (e: unknown, fallback: string) => void
}) {
  const [said, setSaid] = useState<string | null>(null)
  const [before, setBefore] = useState('')
  const [removing, setRemoving] = useState<Removal | null>(null)
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  // A protected export waiting in main for its passphrase (KV-175).
  const [unlocking, setUnlocking] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const real = sessions.filter((r) => r.seeded !== true)

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
      if ('needsPassphrase' in result) {
        setUnlocking(true)
        setSaid('This export is protected. Enter its passphrase to restore it.')
        return
      }
      // Main holds no protected file once another restore has run, so no
      // passphrase field may outlive it (review of #187).
      setUnlocking(false)
      setPassphrase('')
      if (!result.ok) {
        setSaid(describeRefusal(result.refusal))
        return
      }
      await onChanged()
      setSaid(describeRestore(result.outcome, deviceDay))
    }, 'The file could not be restored. Nothing has been changed.')

  const openProtected = (): Promise<void> =>
    step(async () => {
      const typed = passphrase
      setPassphrase('')
      const result = await window.kinvue.restoreProtected(personId, typed)
      if (!result.ok) {
        // A wrong passphrase leaves the file waiting for another try.
        if (result.refusal.kind !== 'wrong-passphrase') setUnlocking(false)
        setSaid(describeRefusal(result.refusal))
        return
      }
      setUnlocking(false)
      await onChanged()
      setSaid(describeRestore(result.outcome, deviceDay))
    }, 'The file could not be restored. Nothing has been changed.')

  const cancelProtected = (): void => {
    setUnlocking(false)
    setPassphrase('')
    setSaid(null)
    void window.kinvue.cancelRestore().catch((e: unknown) => {
      console.error('Could not let go of the protected export.', e)
    })
  }

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

      {protection !== undefined && (
        <p className="mt-2 text-(--color-muted)">{PROTECTION[protection]}</p>
      )}

      <div className="mt-4">
        <button
          type="button"
          disabled={busy || choosing || real.length === 0}
          onClick={() => {
            setSaid(null)
            setChoosing(true)
          }}
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
          Without a passphrase, the file holds every check-in, pain notes included, unprotected.
          Keep it as carefully as this computer.
        </p>
        {choosing && (
          <ExportChoice
            onExport={onExport}
            onCancel={() => setChoosing(false)}
            onDone={(exported) => {
              setChoosing(false)
              if (exported !== null) setSaid(exported)
            }}
          />
        )}
      </div>

      <div className="mt-4">
        {/* Not while a protected export waits for its passphrase: a second
            restore would drop the file main is holding (review of #187). */}
        <button
          type="button"
          disabled={busy || unlocking}
          onClick={() => void restore()}
          className={BUTTON}
        >
          Restore from an export&hellip;
        </button>
        {unlocking && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="restore-passphrase">Passphrase</label>
            <input
              id="restore-passphrase"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="rounded-lg border border-(--color-line) bg-transparent px-2 py-1"
            />
            <button
              type="button"
              disabled={busy || passphrase === ''}
              onClick={() => void openProtected()}
              className={BUTTON}
            >
              Open and restore
            </button>
            <button type="button" disabled={busy} onClick={cancelProtected} className={BUTTON}>
              Cancel
            </button>
          </div>
        )}
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
