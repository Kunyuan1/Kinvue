import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureResult, CheckInAnswers, SessionRecord } from '@core/session/types'
import { DEMO_PERSON_ID, DEMO_PERSON_NAME, withSeededVerdicts } from '@core/seed/persona'
import { hasScorableVitals } from '@core/scoring'
import { DEFAULT_CAPTURE_SECONDS } from '@core/capture/length'
import {
  classifyCaptureError,
  classifyDashboardError,
  classifySubmitError,
  type CaptureFailure,
  type DashboardFailure,
  type SubmitFailure,
} from '@core/capture/failure'
import CaptureScreen from './components/CaptureScreen'
import QuestionFlow from './components/QuestionFlow'
import SessionCard from './components/SessionCard'
import { dashboardErrorText } from './dashboardError'

/**
 * What a finished capture actually produced.
 *
 * A capture that measured nothing must not read as a success: the first real
 * run came back with every metric null and a card that still said "reading
 * taken", which is the reassuring direction and the wrong one. The camera runs
 * for a fixed time whether or not the person is framed, so an empty result is
 * a normal outcome and has to say what to do about it.
 */
function ReadingSummary({
  result,
  onRetake,
  onContinue,
}: {
  result: CaptureResult
  onRetake: () => void
  onContinue: () => void
}): React.JSX.Element {
  const { pulseRateBpm, breathingRateBrpm, hrvRmssdMs } = result.vitals
  const parts = [
    pulseRateBpm === null ? null : `pulse ${pulseRateBpm.toFixed(0)} bpm`,
    breathingRateBrpm === null ? null : `breathing ${breathingRateBrpm.toFixed(0)} br/min`,
    hrvRmssdMs === null ? null : `HRV ${hrvRmssdMs.toFixed(0)} ms`,
  ]
  const measured = parts.filter((part): part is string => part !== null)
  // Asked of the scorer rather than decided again here: the retake is offered
  // on exactly the question the scorer answers with `insufficient-signal`.
  const measuredSomething = hasScorableVitals(result.vitals)

  return (
    <div className="mb-8 rounded-xl border border-(--color-line) bg-(--color-raised) p-5">
      {!measuredSomething ? (
        <>
          <p className="font-medium text-(--color-unknown)">Nothing was measured</p>
          <p className="mt-1 text-sm text-(--color-muted)">
            The camera ran, but no reading came out of it. That usually means the framing
            was not right for long enough — the face centred, chest in view, reasonably
            lit, and still.
          </p>
          <p className="mt-1 text-sm text-(--color-muted)">
            Another try is worth it. Either way the day is worth recording: a check-in
            that says the camera could not tell is still something a caregiver should
            see.
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">Reading taken</p>
          <p className="mt-1 text-sm text-(--color-muted)">{measured.join(' · ')}</p>
          {measured.length < parts.length && (
            <p className="mt-1 text-sm text-(--color-muted)">
              The rest did not settle in the time the camera ran.
            </p>
          )}
        </>
      )}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onRetake}
          className="rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-ground)"
        >
          Try the camera again
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-ground)"
        >
          Answer the questions anyway
        </button>
      </div>
      {/* A failed camera reading is a fact about the day, not an error to
          swallow (KV-7). The questions still get answered and the check-in is
          still stored, with `insufficient-signal` as its verdict — because a
          discarded day and a day nobody sat down look identical in the history,
          and from three hours away that difference is the whole point (#44). */}
    </div>
  )
}

/**
 * The caregiver's view. This app is not used by the person being checked on —
 * every string on this screen is addressed to whoever looks after them, which
 * is the framing the whole product hangs on. Keep it that way.
 *
 * SCAFFOLD (KV-4): the loop closes here — a capture leads into the four
 * questions, and answering them stores a scored session that appears in the
 * list below. What is still missing is the trend view (KV-4).
 */
export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null)
  // The sentence, and which failure it is: an unreadable history is the one
  // that offers a way out (KV-98), so the box needs to know which it is showing.
  const [error, setError] = useState<{ text: string; failure: DashboardFailure } | null>(null)
  // Said once a new history has been started, naming where the old one went.
  const [notice, setNotice] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  // Asked of main rather than assumed: the countdown and the sentence under
  // the button both have to be the length a capture will actually run (#63).
  // The same constant main defaults to, so the one render before the answer
  // arrives is right whenever the setting is unset.
  const [captureSeconds, setCaptureSeconds] = useState(DEFAULT_CAPTURE_SECONDS)
  const [captureFailure, setCaptureFailure] = useState<CaptureFailure | null>(null)
  const [answering, setAnswering] = useState<CaptureResult | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | null>(null)
  const captureGeneration = useRef(0)
  const [reading, setReading] = useState<CaptureResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setSessions(await window.kinvue.listSessions(DEMO_PERSON_ID))
    // A list that loaded is the current state of the screen, so an earlier
    // failure to load it is no longer true (KV-95 review). The post-submit
    // sentence is set only after its own refresh has failed, so this never
    // clears it.
    setError(null)
  }, [])

  // An unreadable history says so in its own words; anything else gets a plain
  // sentence here and the original in the console (KV-95).
  const showFailure = useCallback((e: unknown, fallback: string): void => {
    console.error(e)
    setError({ text: dashboardErrorText(e, fallback), failure: classifyDashboardError(e) })
  }, [])

  useEffect(() => {
    void refresh().catch((e: unknown) => showFailure(e, 'The check-ins could not be shown.'))
  }, [refresh, showFailure])

  useEffect(() => {
    // Not worth a screen: the fallback is the default, so a failure here is
    // invisible when the setting is unset. It is *not* harmless when it is set
    // — the button would promise 30 seconds while the capture runs 60, and the
    // countdown would reach "Finishing up" half a minute early — so the failure
    // is recorded rather than swallowed.
    void window.kinvue.captureSeconds().then(setCaptureSeconds, (err: unknown) => {
      console.error('Could not read the capture length; using the default.', err)
    })
  }, [])

  // KV-98. The caregiver's choice, never automatic. Main re-checks before it
  // moves anything, so a history that has become readable since the error was
  // shown comes back as null and is simply loaded.
  const startNewHistory = async (): Promise<void> => {
    let aside: string | null
    try {
      aside = await window.kinvue.startNewHistory()
    } catch (e) {
      showFailure(e, 'A new history could not be started.')
      return
    }
    try {
      await refresh()
    } catch (e) {
      showFailure(e, 'A new history was started, but the list could not be reloaded.')
      return
    }
    if (aside !== null) {
      setNotice(`A new, empty history was started. The old file was kept, unchanged, as ${aside}.`)
    }
  }

  // Two steps that fail differently. Seeding can succeed and the reload after
  // it fail — a sync client briefly holding the file — and "could not be added"
  // would then be false with a fortnight sitting in it (KV-95 review). The
  // submit path makes the same split for the same reason.
  const seed = async (): Promise<void> => {
    try {
      await window.kinvue.seedDemo()
    } catch (e) {
      showFailure(e, 'The demo history could not be added.')
      return
    }
    await refresh().catch((e: unknown) =>
      showFailure(e, 'The demo history was added, but the list could not be reloaded.'),
    )
  }

  // Seeded days are scored here, as they are shown, so the demo always shows the
  // current scorer's verdict (KV-103). Real check-ins keep the one they were given.
  const newest = sessions === null ? [] : withSeededVerdicts(sessions).reverse()

  /**
   * Started here, on the press, rather than inside the capture screen. Opening
   * the camera cannot be undone, and React runs an effect twice in development
   * — which asked main for two captures and had the second refused.
   */
  const startCapture = useCallback((): void => {
    setReading(null)
    setCaptureFailure(null)
    setCapturing(true)

    // Which capture this is. A stopped capture still resolves in main, and
    // without this its reading arrived half a minute later and appeared on the
    // dashboard — a card for a run the person deliberately abandoned, or worse,
    // one that yanked them off an error screen.
    const started = ++captureGeneration.current

    window.kinvue
      .capture(DEMO_PERSON_ID)
      .then((result) => {
        if (started !== captureGeneration.current) return
        setCapturing(false)
        // The reading stays in main. What crosses back is its id, and the
        // questions are what turn it into a check-in. A capture that measured
        // nothing is shown first: answering four questions about a reading
        // that does not exist should be a choice, not something that happens.
        if (hasScorableVitals(result.vitals)) setAnswering(result)
        else setReading(result)
      })
      .catch((e: unknown) => {
        if (started !== captureGeneration.current) return
        const failure = classifyCaptureError(e)
        // Null is cancellation: nothing to say, and nothing left to show it on
        // either. Leaving `capturing` true would keep the capture screen up —
        // frozen self-view, a countdown stuck at its last tick and a Stop button
        // — for a capture that has already ended, shown to the one person in
        // this app who is being filmed. Today the generation guard in
        // `stopCapture` means a user-pressed stop never reaches here, but that
        // is an invariant in another file, and a cancellation the person did
        // not ask for would arrive on exactly this path.
        if (failure === null) {
          setCapturing(false)
          return
        }
        setCaptureFailure(failure)
      })
  }, [])

  /** Stops the camera, then leaves the screen. */
  const stopCapture = useCallback((): void => {
    captureGeneration.current++
    setCapturing(false)
    void window.kinvue.cancelCapture().catch(() => {
      // Nothing useful to say: the screen is already gone and the capture is
      // abandoned either way.
    })
  }, [])

  /** Submits the answers against the reading main is holding. */
  const submit = useCallback(
    (answers: CheckInAnswers): void => {
      if (answering === null) return
      setSubmitting(true)
      setSubmitFailure(null)

      window.kinvue
        .submit(DEMO_PERSON_ID, answering.captureId, answers)
        .then(async () => {
          // The check-in is stored by the time this runs, so a refresh that
          // fails now is a stale list, not a lost check-in — and it has to be
          // said on the dashboard, because `submitError` is rendered only by
          // the screen that clearing `answering` unmounts. Dropped silently, it
          // sent the person back to take a second reading of the same moment,
          // which would then enter the baseline twice.
          await refresh().catch(() => {
            setError({
              text: 'The check-in was saved, but the list could not be reloaded.',
              failure: 'unknown',
            })
          })
          setAnswering(null)
          setReading(null)
          setSubmitting(false)
        })
        .catch((e: unknown) => {
          setSubmitting(false)
          setSubmitFailure(classifySubmitError(e))
        })
    },
    [answering, refresh],
  )

  if (capturing) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <CaptureScreen
          failure={captureFailure}
          onCancel={stopCapture}
          captureSeconds={captureSeconds}
        />
      </main>
    )
  }

  if (answering !== null) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <QuestionFlow
          onDone={submit}
          onCancel={() => {
            // Nothing is stored, which is the honest outcome of a check-in
            // someone chose not to finish. But main holds that reading as
            // submittable for another fifteen minutes, so it goes back to the
            // dashboard rather than becoming unreachable — "Not now" sits
            // under the answer buttons on a screen built for an unsteady hand,
            // and a mis-tap there should not cost a good 30-second reading.
            setReading(answering)
            setAnswering(null)
            setSubmitFailure(null)
          }}
          submitting={submitting}
          failure={submitFailure}
        />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">{DEMO_PERSON_NAME}&rsquo;s check-ins</h1>
        <p className="mt-1 text-sm text-(--color-muted)">
          A daily look at whether today is different from {DEMO_PERSON_NAME}&rsquo;s own
          usual. Not a diagnosis, and not an emergency alert.
        </p>
      </header>

      <div className="mb-8 flex items-center gap-3">
        <button
          type="button"
          onClick={startCapture}
          className="rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
        >
          Take a reading
        </button>
        <span className="text-sm text-(--color-muted)">
          Up to {captureSeconds} seconds in front of the camera.
        </span>
      </div>

      {reading !== null && (
        <ReadingSummary
          result={reading}
          onRetake={startCapture}
          onContinue={() => {
            setAnswering(reading)
            setReading(null)
          }}
        />
      )}

      {error !== null && (
        <div className="mb-6 rounded-lg border border-(--color-line) p-4 text-sm">
          <p className="text-(--color-elevated)">{error.text}</p>
          {error.failure === 'store-unreadable' && (
            <>
              <p className="mt-2 text-(--color-muted)">
                Starting a new history keeps this file as it is, renamed beside it, and begins
                an empty one. Nothing in the old file is deleted.
              </p>
              <button
                type="button"
                onClick={() => void startNewHistory()}
                className="mt-3 rounded-lg border border-(--color-line) px-4 py-2 hover:bg-(--color-raised)"
              >
                Start a new history
              </button>
            </>
          )}
        </div>
      )}

      {notice !== null && (
        <p className="mb-6 rounded-lg border border-(--color-line) p-4 text-sm text-(--color-muted)">
          {notice}
        </p>
      )}

      {sessions !== null && sessions.length === 0 && (
        <div className="rounded-xl border border-dashed border-(--color-line) p-8 text-center">
          <p className="text-sm text-(--color-muted)">
            No check-ins yet. Seed the demo persona&rsquo;s history to see the dashboard
            with a baseline behind it.
          </p>
          <button
            type="button"
            onClick={() => void seed()}
            className="mt-4 rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
          >
            Seed demo history
          </button>
        </div>
      )}

      <div className="space-y-4">
        {newest.map((session) => (
          <SessionCard key={session.id} session={session} />
        ))}
      </div>
    </main>
  )
}
