import { useId, useState } from 'react'
import { MAX_NAME_LENGTH, NAME_PROBLEM, normalName } from '@core/session/people'
import type { NamedResult, PersonShown } from '../../shared/people'

const BUTTON =
  'rounded-lg border border-(--color-line) px-4 py-2' +
  ' enabled:hover:bg-(--color-raised) disabled:cursor-not-allowed disabled:opacity-50'

/**
 * A person's name, typed in (KV-18): whose the check-ins are, on the first-run
 * screen, for a history from before KV-18 or for the first person on a new
 * install.
 *
 * Held to the name rule in main, against everyone else on this computer, which
 * says why a name was not taken; the line under the field says it. The field
 * keeps what was typed when it is refused, so it can be corrected.
 */
export default function NameField({
  label,
  save,
  onNamed,
}: {
  label: string
  /** Asks main to keep the name: adding someone, or naming someone already here. */
  save: (name: string) => Promise<NamedResult>
  /** Once a name is kept: the person as now named. */
  onNamed: (person: PersonShown) => void
}) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  // Empty as the store means it (review of #200): `normalName`, not `trim`
  // alone, so the field and the store cannot disagree about a blank name.
  const blank = normalName(typed) === ''

  const keep = async (): Promise<void> => {
    setBusy(true)
    setSaid(null)
    try {
      const result = await save(typed)
      if (!result.ok) {
        setSaid(NAME_PROBLEM[result.problem])
        return
      }
      onNamed(result.person)
    } catch (e) {
      console.error('Could not keep the name.', e)
      setSaid('The name could not be saved. Nothing has been changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      {/* A form, so Enter saves, as the key's field does. */}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && !blank) void keep()
        }}
      >
        <label htmlFor={`${id}-name`}>{label}</label>
        {/* Not capped here: a name over the limit is said to be, rather than
            cut off as it is typed with no word why. */}
        <input
          id={`${id}-name`}
          type="text"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-describedby={`${id}-said`}
          className="min-w-64 rounded-lg border border-(--color-line) bg-transparent px-2 py-1"
        />
        <button type="submit" disabled={busy || blank} className={BUTTON}>
          Save the name
        </button>
      </form>
      <p id={`${id}-said`} aria-live="polite" className="mt-2 min-h-5 text-sm text-(--color-muted)">
        {said ?? `Up to ${String(MAX_NAME_LENGTH)} characters.`}
      </p>
    </div>
  )
}
