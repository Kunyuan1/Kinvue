import { seededDisclosureFor, uncomparedDisclosure } from '@core/scoring'
import { describeAnswers } from '@core/session/answers'
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
  // only where something on this card actually leans on the baseline (KV-53),
  // and not on a seeded card, whose own label already says so (KV-103).
  const seededNote = seededDisclosureFor(session)
  // A metric measured at this check-in and never compared (KV-87). Above the
  // seeded note: on a withheld card it is the reason for the verdict.
  const uncomparedNote = assessment === undefined ? null : uncomparedDisclosure(assessment)
  // The day and time where the person was, not where whoever is reading this
  // happens to be (KV-28). Formatted in the recorded zone directly — turning it
  // into a date string and parsing that back would depend on the locale's
  // format and renders the words "Invalid Date" when it does not match.
  // A record written before zones existed falls back to the reader's zone,
  // because nothing better is knowable about it.
  const zone = session.timeZone === '' ? undefined : session.timeZone
  const inZone = zone === undefined ? {} : { timeZone: zone }
  const at = new Date(capturedAt)
  const when = at.toLocaleDateString(undefined, {
    ...inZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  // When the reader is somewhere else, the date alone is ambiguous: "Tue, Sep
  // 15" could be a day stale or an hour old. The time and place say which, and
  // are the only thing on the card that shows the zone doing any work.
  const readerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const elsewhere = zone !== undefined && zone !== readerZone
  const localTime = elsewhere
    ? `${at.toLocaleTimeString(undefined, { ...inZone, hour: 'numeric', minute: '2-digit' })}, ${zone.split('/').pop()?.replace(/_/g, ' ') ?? zone}`
    : null

  return (
    <article className="rounded-xl border border-(--color-line) bg-(--color-raised) p-5">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <p className={`font-medium ${FLAG_COLOR[flag]}`}>{FLAG_LABEL[flag]}</p>
          <p className="text-sm text-(--color-muted)">{assessment?.summary}</p>
          {uncomparedNote !== null && (
            <p className="mt-1 text-sm text-(--color-muted)">{uncomparedNote}</p>
          )}
          {seededNote !== null && (
            <p className="mt-1 text-sm text-(--color-muted)">{seededNote}</p>
          )}
        </div>
        <div className="shrink-0 text-right text-sm text-(--color-muted)">
          <p>{when}</p>
          {/* Seeded demo history is labelled, never passed off as measured. */}
          {localTime !== null && <p className="text-xs">{localTime}</p>}
          {seeded === true && <p className="text-xs">seeded demo data</p>}
        </div>
      </header>

      <dl className="mt-4 flex gap-6 text-sm">
        <Reading label="Pulse" value={vitals.pulseRateBpm} unit="bpm" />
        <Reading label="Breathing" value={vitals.breathingRateBrpm} unit="br/min" />
        <Reading label="HRV" value={vitals.hrvRmssdMs} unit="ms" />
      </dl>

      {/*
        Every answer, whatever it was (KV-110). Until this a card showed an
        answer only when a rule fired on it, so no sleep line could mean well,
        all right, or unknown. A record of the answers, as labels rather than
        sentences so it neither repeats the rules nor quotes anyone — seeded
        cards included — and muted so it reads as context, not as the part
        that counted: the rules below say that.
      */}
      <p className="mt-4 text-sm text-(--color-muted)">
        Answers: {describeAnswers(session.answers).join(' · ')}
      </p>

      {/*
        The person's own words about their own pain, shown to the caregiver
        unedited and attributed (KV-2). Withholding it would be the wrong kind
        of discretion: a caregiver deciding whether to drive over is better
        served by "left hip, since yesterday" than by a rule that says pain was
        reported. It is never summarised, never paraphrased, and never used as
        a rule input — whether it may ever leave the device is KV-32. Its line
        breaks are kept for the same reason: collapsing them would be a silent
        edit in the one place nothing should be edited.
      */}
      {session.answers.painNote !== undefined && (
        <p className="mt-4 border-t border-(--color-line) pt-4 text-sm whitespace-pre-wrap">
          <span className="text-(--color-muted)">In their words: </span>
          {session.answers.painNote}
        </p>
      )}

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
