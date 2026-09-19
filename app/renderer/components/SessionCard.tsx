import { seededBaselineDisclosure } from '@core/scoring'
import { localDateOf } from '@core/session/time'
import type { Flag, SessionRecord } from '@core/session/types'

const FLAG_LABEL: Record<Flag, string> = {
  normal: 'Looks normal',
  elevated: 'Looks different',
  'insufficient-signal': 'Not enough to say',
}

const FLAG_COLOR: Record<Flag, string> = {
  normal: 'text-(--color-normal)',
  elevated: 'text-(--color-elevated)',
  'insufficient-signal': 'text-(--color-unknown)',
}

/**
 * One check-in as the caregiver sees it. The fired rules are always rendered,
 * including on a normal day — the explanation is the product, so it does not
 * collapse behind a disclosure triangle.
 */
export default function SessionCard({ session }: { session: SessionRecord }): React.JSX.Element {
  const { assessment, vitals, capturedAt, seeded } = session
  const flag = assessment?.flag ?? 'insufficient-signal'
  // Composed from the stored counts, not read out of the summary: it appears
  // only where something on this card actually leans on the baseline (KV-53).
  const seededNote = assessment === undefined ? null : seededBaselineDisclosure(assessment)
  // The day the check-in happened where the person was, not where whoever is
  // reading this happens to be (KV-28). Rendered from the recorded local date
  // so a caregiver in another zone is not shown a different day than the one
  // the person lived. Records written before zones existed keep the old
  // behaviour, which is the reader's zone, because nothing better is knowable.
  const localDate = localDateOf(session)
  const when = (localDate === null ? new Date(capturedAt) : new Date(`${localDate}T00:00:00`))
    .toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })

  return (
    <article className="rounded-xl border border-(--color-line) bg-(--color-raised) p-5">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <p className={`font-medium ${FLAG_COLOR[flag]}`}>{FLAG_LABEL[flag]}</p>
          <p className="text-sm text-(--color-muted)">{assessment?.summary}</p>
          {seededNote !== null && (
            <p className="mt-1 text-sm text-(--color-muted)">{seededNote}</p>
          )}
        </div>
        <div className="shrink-0 text-right text-sm text-(--color-muted)">
          <p>{when}</p>
          {/* Seeded demo history is labelled, never passed off as measured. */}
          {seeded === true && <p className="text-xs">seeded demo data</p>}
        </div>
      </header>

      <dl className="mt-4 flex gap-6 text-sm">
        <Reading label="Pulse" value={vitals.pulseRateBpm} unit="bpm" />
        <Reading label="Breathing" value={vitals.breathingRateBrpm} unit="br/min" />
        <Reading label="HRV" value={vitals.hrvRmssdMs} unit="ms" />
      </dl>

      {assessment !== undefined && assessment.firedRules.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-(--color-line) pt-4">
          {assessment.firedRules.map((rule) => (
            <li key={rule.id} className="text-sm">
              <span className="font-medium">{rule.title}</span>
              <span className="text-(--color-muted)"> — {rule.explanation}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function Reading({
  label,
  value,
  unit,
}: {
  label: string
  value: number | null
  unit: string
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-(--color-muted)">{label}</dt>
      <dd className="tabular-nums">
        {value === null ? '—' : `${Math.round(value)} ${unit}`}
      </dd>
    </div>
  )
}
