import { useState } from 'react'
import type { SessionRecord } from '@core/session/types'
import {
  chosenFor,
  describeLastExport,
  describeAdded,
  describeRefusal,
  describeRestore,
  type Removal,
  type RestoredInto,
  type RestoreResult,
} from '@core/session/lifecycle'
import type { Protection } from '../../shared/protection'
import ConfirmRemoval, { whoseHistory } from './ConfirmRemoval'
import ExportChoice from './ExportChoice'

// Dimmed, with no hover, when disabled (KV-175): a guard that looks live is no guard.
const BUTTON = 'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

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
 * passphrase (KV-175, T16); without one it is that person's whole history,
 * pain notes included, readable wherever it is put, and the note beside it
 * says so. An export, and deleting everything, are the person shown's, never
 * the household's (KV-18), and the heading and button name them (KV-209).
 *
 * It also says whether the history here is encrypted with this computer's key
 * (KV-175), and what that does not cover — or that it is not encrypted, where
 * the computer offers no key store.
 */
export default function HistoryPanel({
  personId,
  name,
  sessions,
  lastExported,
  protection,
  onExport,
  onChanged,
  onRestored,
  onFailure,
}: {
  personId: string
  /** The person shown's name; null when they have not been named yet. */
  name: string | null
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
  /** After a deletion: reloads the list. */
  onChanged: () => Promise<void>
  /**
   * After a restore (KV-18): shows whoever the file went into, which the file
   * decides, not this panel — and asks for their name when they came without
   * one.
   */
  onRestored: (into: RestoredInto) => Promise<void>
  onFailure: (e: unknown, fallback: string) => void
}) {
  const [said, setSaid] = useState<string | null>(null)
  const [before, setBefore] = useState('')
  const [removing, setRemoving] = useState<Removal | null>(null)
  // An export from before keys, asking whose it is before main writes it
  // (KV-18): the question, until it is answered.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [choosing, setChoosing] = useState(false)
  // A protected export waiting in main for its passphrase (KV-175).
  const [unlocking, setUnlocking] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const real = sessions.filter((r) => r.seeded !== true)
  const whose = whoseHistory(personId, name)

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

  /** What any restore came to, plain, protected or confirmed. */
  const landed = async (result: RestoreResult): Promise<void> => {
    if (!result.ok) {
      // A question, not a refusal: main holds the file until it is answered.
      if (result.refusal.kind === 'before-keys') {
        setConfirming(describeRefusal(result.refusal, deviceDay))
        return
      }
      setSaid(describeRefusal(result.refusal, deviceDay))
      return
    }
    // Said before the reload, and kept if the reload fails: written is written,
    // and the step's own "nothing has been changed" would be false over it
    // (review of #207).
    const said = describeRestore(result.outcome, deviceDay) + describeAdded(result.into.added)
    setSaid(said)
    try {
      await onRestored(result.into)
    } catch (e) {
      onFailure(e, `${said} The list could not be reloaded.`)
    }
  }

  const restore = (): Promise<void> =>
    step(async () => {
      setConfirming(null)
      const result = await window.kinvue.restoreHistory()
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
      await landed(result)
    }, 'The file could not be restored. Nothing has been changed.')

  const openProtected = (): Promise<void> =>
    step(async () => {
      const typed = passphrase
      setPassphrase('')
      const result = await window.kinvue.restoreProtected(typed)
      // A wrong passphrase leaves the file waiting for another try.
      if (result.ok || result.refusal.kind !== 'wrong-passphrase') setUnlocking(false)
      await landed(result)
    }, 'The file could not be restored. Nothing has been changed.')

  const confirm = (): Promise<void> =>
    step(async () => {
      setConfirming(null)
      await landed(await window.kinvue.restoreConfirmed())
    }, 'The file could not be restored. Nothing has been changed.')

  const cancelConfirming = (): void => {
    setConfirming(null)
    // Said: the question going was all there was to see (review of #207).
    setSaid('Nothing has been restored.')
    void window.kinvue.cancelRestore().catch((e: unknown) => {
      console.error('Could not let go of the export waiting to be confirmed.', e)
    })
  }

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
        {whose.heading}
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
        {/* Not while a file waits in main — for its passphrase, or to be told
            whose it is: a second restore would drop it (review of #187).
            Whoever is shown, the demo included: the file says whose it is
            (KV-18), and goes into them. */}
        <button
          type="button"
          disabled={busy || unlocking || confirming !== null}
          onClick={() => void restore()}
          className={BUTTON}
        >
          Restore from an export&hellip;
        </button>
        <p className="mt-2 text-(--color-muted)">
          An export goes back into the history of whoever it is, whoever is shown here.
        </p>
        {confirming !== null && (
          <div role="group" aria-labelledby="restore-confirm" className="mt-3">
            <p id="restore-confirm">{confirming}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {/* Cancel has the focus: nothing is written until this is answered. */}
              <button
                type="button"
                autoFocus
                disabled={busy}
                onClick={cancelConfirming}
                className={BUTTON}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirm()}
                className={BUTTON}
              >
                Restore it
              </button>
            </div>
          </div>
        )}
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
            Delete {whose.all}&hellip;
          </button>
        </div>
      )}

      {removing !== null && (
        <ConfirmRemoval
          sessions={sessions}
          personId={personId}
          name={name}
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
