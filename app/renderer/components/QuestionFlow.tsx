import { useState } from 'react'
import { answeredCount, draftToAnswers, type AnswerDraft } from '@core/session/answers'
import type { CheckInAnswers } from '@core/session/types'

/**
 * The four questions, asked one at a time.
 *
 * **Addressed to the cared-for person**, like the capture screen and unlike
 * everywhere else in the app. They are the one answering; the caregiver reads
 * the result later.
 *
 * One question per screen, with large targets and no free text until the last
 * one. The reader may be 82 and may be doing this at seven in the morning, so
 * nothing here depends on precision or on remembering what was asked before.
 *
 * Nothing can be skipped. `CheckInAnswers` has no way to say "not asked", and
 * a missing answer that arrived as `false` would fire the `not-eaten` rule on
 * a question nobody put to them. See `core/session/answers.ts`.
 */

const TOTAL = 4

export default function QuestionFlow({
  onDone,
  onCancel,
  submitting,
  error,
}: {
  onDone: (answers: CheckInAnswers) => void
  onCancel: () => void
  submitting: boolean
  error: string | null
}): React.JSX.Element {
  const [draft, setDraft] = useState<AnswerDraft>({})
  const [step, setStep] = useState(0)

  const answer = (patch: AnswerDraft): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    // Pain is the last question and opens the note, so it stays put.
    if (patch.painReported === undefined) setStep((s) => s + 1)
  }

  const finish = (): void => {
    const answers = draftToAnswers(draft)
    // Null only if a question is unanswered, which the flow does not allow —
    // but submitting a partial set is the one outcome worth being sure of.
    if (answers !== null) onDone(answers)
  }

  const done = answeredCount(draft)

  return (
    <section className="mx-auto max-w-xl">
      <p className="text-center text-sm text-(--color-muted)">
        Question {Math.min(step + 1, TOTAL)} of {TOTAL}
      </p>

      {step === 0 && (
        <Question title="How are you feeling today?">
          <Choice onClick={() => answer({ mood: 'good' })}>Good</Choice>
          <Choice onClick={() => answer({ mood: 'ok' })}>All right</Choice>
          <Choice onClick={() => answer({ mood: 'low' })}>Low</Choice>
        </Question>
      )}

      {step === 1 && (
        <Question title="How did you sleep?">
          <Choice onClick={() => answer({ sleep: 'well' })}>Well</Choice>
          <Choice onClick={() => answer({ sleep: 'ok' })}>All right</Choice>
          <Choice onClick={() => answer({ sleep: 'poorly' })}>Badly</Choice>
        </Question>
      )}

      {step === 2 && (
        <Question title="Have you eaten today?">
          <Choice onClick={() => answer({ eatenToday: true })}>Yes</Choice>
          <Choice onClick={() => answer({ eatenToday: false })}>Not yet</Choice>
        </Question>
      )}

      {step === 3 && (
        <Question title="Are you in any pain today?">
          {draft.painReported === undefined && (
            <>
              <Choice onClick={() => answer({ painReported: false })}>No</Choice>
              <Choice onClick={() => answer({ painReported: true })}>Yes</Choice>
            </>
          )}

          {draft.painReported === false && (
            <p className="text-center text-sm text-(--color-muted)">
              Good. That is everything.
            </p>
          )}

          {draft.painReported === true && (
            <label className="block text-left">
              <span className="text-sm text-(--color-muted)">
                If you would like to say where, you can. It is not required.
              </span>
              <textarea
                value={draft.painNote ?? ''}
                onChange={(e) => setDraft({ ...draft, painNote: e.target.value })}
                rows={3}
                className="mt-2 w-full rounded-lg border border-(--color-line) bg-(--color-raised) p-3 text-base"
              />
            </label>
          )}
        </Question>
      )}

      {error !== null && (
        <p className="mt-6 rounded-lg border border-(--color-line) p-4 text-center text-sm text-(--color-elevated)">
          {error}
        </p>
      )}

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-(--color-muted) underline hover:text-(--color-ink)"
        >
          Not now
        </button>

        {done === TOTAL && (
          <button
            type="button"
            onClick={finish}
            disabled={submitting}
            className="rounded-lg border border-(--color-line) px-5 py-3 text-base hover:bg-(--color-raised) disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Finish'}
          </button>
        )}
      </div>
    </section>
  )
}

function Question({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mt-6">
      <h2 className="text-center text-xl font-semibold">{title}</h2>
      <div className="mt-6 space-y-3">{children}</div>
    </div>
  )
}

/** Deliberately large: the person answering may not have a steady hand. */
function Choice({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-(--color-line) bg-(--color-raised) px-5 py-4 text-left text-lg hover:border-(--color-muted)"
    >
      {children}
    </button>
  )
}
