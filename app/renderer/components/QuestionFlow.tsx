import { useState } from 'react'
import {
  ANSWER_STEPS,
  answeredCount,
  draftToAnswers,
  type AnswerDraft,
} from '@core/session/answers'
import type { SubmitFailure } from '@core/capture/failure'
import type { CheckInAnswers } from '@core/session/types'
import { MAX_PAIN_NOTE_LENGTH } from '@core/session/validate'

/**
 * The four questions, asked one at a time.
 *
 * **Addressed to the cared-for person**, like the capture screen and unlike
 * everywhere else in the app. They are the one answering; the caregiver reads
 * the result later.
 *
 * One question per screen, with large targets and no free text until the last
 * one. The reader may be 82 and may be doing this at seven in the morning, so
 * nothing here depends on precision of memory, on remembering what was asked
 * before — or on tapping the button they meant. Every answer stays visible and
 * changeable, and every question can be gone back to: `mood` is a scorer input,
 * so a mis-tap is not cosmetic, and the flow was previously forward-only on the
 * screen least able to afford that.
 *
 * Nothing can be skipped. `CheckInAnswers` has no way to say "not asked", and
 * a missing answer that arrived as `false` would fire the `not-eaten` rule on
 * a question nobody put to them. See `core/session/answers.ts`.
 */

/**
 * What the person is told when their answers cannot be stored (KV-7).
 *
 * The reading itself is held in the main process, so what fails here is
 * almost always the reading having gone rather than anything about the
 * answers — and none of it is about them.
 */
const SUBMIT_FAILURE: Record<SubmitFailure, string> = {
  expired: 'Too long passed since the reading was taken. Taking a new one is the way forward.',
  'no-capture': 'That reading is no longer available. Taking a new one is the way forward.',
  // The one submit failure that retrying cannot fix, so it is the one that
  // must not say "try again" (KV-13). The file will fail to parse identically
  // every time until a new history is started, and the answers are held in the
  // main process meanwhile — so this says what is wrong and where the way out
  // is, and stops. The way out is the dashboard's *Start a new history* (KV-98),
  // one screen away. This screen is read by the person being measured too, so it
  // points there for whoever looks after the computer rather than asking them to
  // do it, and it carries no path: the dashboard names the file, and names where
  // it went once it is set aside.
  'store-unreadable':
    'The saved check-in history could not be opened, so this check-in has not been stored. ' +
    'Nothing already saved has been changed. Whoever looks after this computer can start ' +
    'a new history from the main screen.',
  // Says nothing about taking a new reading, deliberately. Every untagged
  // write failure lands here — a full disk, a permission — and `createCheckIn`
  // refiles the held reading on exactly that path, so the
  // answers and the capture are both still submittable. Sending the person to
  // the camera would spend a good 30-second reading and four answers to fail
  // in the same way (KV-7).
  //
  // Since KV-75 this bucket also holds capture-path tags, which `ON_SUBMIT`
  // routes here because this screen has no words for them. The refiling
  // argument above does not cover those — it is about untagged write failures
  // — and nothing can raise one on this path today, because the camera has
  // been closed since before the questions were asked. If that ever changes,
  // this sentence needs revisiting rather than widening (KV-80).
  //
  // A corrupt store used to land here too, and that was the bug KV-13's review
  // caught: retrying clears a full disk, never an unparseable file. It has its
  // own entry above.
  unknown: 'The check-in could not be saved. Trying again is worth a go.',
}

/** Add a fifth question to `ANSWER_STEPS` and this follows it. */
const TOTAL = ANSWER_STEPS.length

export default function QuestionFlow({
  onDone,
  onCancel,
  submitting,
  failure,
}: {
  onDone: (answers: CheckInAnswers) => void
  onCancel: () => void
  submitting: boolean
  failure: SubmitFailure | null
}): React.JSX.Element {
  const [draft, setDraft] = useState<AnswerDraft>({})
  const [step, setStep] = useState(0)

  const answer = (patch: AnswerDraft): void => {
    setDraft({ ...draft, ...patch })
    // Decided by which step this is, not by which field was patched: the last
    // question opens the note and so stays put, and an answer changed on a
    // step gone back to still moves forward from there.
    if (step < TOTAL - 1) setStep(step + 1)
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
          <Choice chosen={draft.mood === 'good'} onClick={() => answer({ mood: 'good' })}>
            Good
          </Choice>
          <Choice chosen={draft.mood === 'ok'} onClick={() => answer({ mood: 'ok' })}>
            All right
          </Choice>
          <Choice chosen={draft.mood === 'low'} onClick={() => answer({ mood: 'low' })}>
            Low
          </Choice>
        </Question>
      )}

      {step === 1 && (
        <Question title="How did you sleep?">
          <Choice chosen={draft.sleep === 'well'} onClick={() => answer({ sleep: 'well' })}>
            Well
          </Choice>
          <Choice chosen={draft.sleep === 'ok'} onClick={() => answer({ sleep: 'ok' })}>
            All right
          </Choice>
          <Choice
            chosen={draft.sleep === 'poorly'}
            onClick={() => answer({ sleep: 'poorly' })}
          >
            Badly
          </Choice>
        </Question>
      )}

      {step === 2 && (
        <Question title="Have you eaten today?">
          <Choice chosen={draft.eatenToday === true} onClick={() => answer({ eatenToday: true })}>
            Yes
          </Choice>
          <Choice
            chosen={draft.eatenToday === false}
            onClick={() => answer({ eatenToday: false })}
          >
            Not yet
          </Choice>
        </Question>
      )}

      {step === 3 && (
        <Question title="Are you in any pain today?">
          {/* Still on screen once answered: "No" was as final as a mis-tap on
              any other question, and this is the one that decides whether the
              note is even offered. */}
          <Choice
            chosen={draft.painReported === false}
            onClick={() => answer({ painReported: false })}
          >
            No
          </Choice>
          <Choice
            chosen={draft.painReported === true}
            onClick={() => answer({ painReported: true })}
          >
            Yes
          </Choice>

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
              {/* Capped where the caller can see it rather than at the process
                  boundary, which rejects the whole check-in for a note that is
                  too long and cannot say which of the five answers was the
                  problem. `draftToAnswers` trims, so a note that fits here
                  fits there. */}
              <textarea
                value={draft.painNote ?? ''}
                onChange={(e) => setDraft({ ...draft, painNote: e.target.value })}
                maxLength={MAX_PAIN_NOTE_LENGTH}
                rows={3}
                className="mt-2 w-full rounded-lg border border-(--color-line) bg-(--color-raised) p-3 text-base"
              />
            </label>
          )}
        </Question>
      )}

      {failure !== null && (
        <p className="mt-6 rounded-lg border border-(--color-line) p-4 text-center text-base text-(--color-elevated)">
          {SUBMIT_FAILURE[failure]}
        </p>
      )}

      <div className="mt-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-(--color-muted) underline hover:text-(--color-ink)"
          >
            Not now
          </button>
        </div>

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

/**
 * Deliberately large: the person answering may not have a steady hand. `chosen`
 * is what makes an answer correctable — the button stays on screen showing what
 * was tapped, and tapping another one replaces it.
 */
function Choice({
  chosen,
  onClick,
  children,
}: {
  chosen: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={chosen}
      className={`w-full rounded-xl border bg-(--color-raised) px-5 py-4 text-left text-lg hover:border-(--color-muted) ${
        chosen ? 'border-(--color-ink) font-medium' : 'border-(--color-line)'
      }`}
    >
      {children}
    </button>
  )
}
