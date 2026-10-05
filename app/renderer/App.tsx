import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureResult, CheckInAnswers, SessionRecord } from '@core/session/types'
import { DEMO_PERSON_ID, DEMO_PERSON_NAME } from '@core/seed/persona'
import { hasScorableVitals, learningStatus, presentAll, usualReachStatus } from '@core/scoring'
import { DEFAULT_CAPTURE_SECONDS } from '@core/capture/length'
import {
  classifyCaptureError,
  classifyDashboardError,
  classifySubmitError,
  type CaptureFailure,
  type DashboardFailure,
  type SubmitFailure,
} from '@core/capture/failure'
import { CARD_BOX, CHART_BOX } from './components/boxes'
import CaptureScreen from './components/CaptureScreen'
import ConfirmRemoval from './components/ConfirmRemoval'
import HistoryPanel from './components/HistoryPanel'
import QuestionFlow from './components/QuestionFlow'
import SectionBoundary from './components/SectionBoundary'
import SessionCard from './components/SessionCard'
import TrendChart from './components/TrendChart'
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
 * The loop closes here: a capture leads into the four questions, answering
 * them stores a scored session that appears in the list below, and the trend
 * above the list draws one metric over the baseline window (KV-4).
 */
export default function App(): React.JSX.Element {
  // Each press of "Try again" draws the screen from nothing: a new key for the
  // boundary and a fresh `Dashboard`, which loads the history again.
  const [attempt, setAttempt] = useState(0)

  // The last resort (KV-163). Everything that reads a record is contained
  // closer in — each card, the chart, the baseline lines, the capture and the
  // questions — so this is for a throw in the screen's own code. It covers the
  // screens the cared-for person reads too, so the sentence names no one.
  //
  // Whatever it catches, a capture may be running: the camera would stay on,
  // with the Stop button gone, until its ceiling (review of #164). So it is
  // abandoned — asking when none is running does nothing. And the way out is
  // "Try again", not a restart: a throw that happens every time happens after
  // a restart too, and the inner boundaries keep a record that always throws
  // from ever reaching here.
  return (
    <SectionBoundary
      as="main"
      fallback="Kinvue could not show this screen. Nothing saved has been changed."
      className="mx-auto max-w-3xl px-6 py-10"
      resetKey={attempt}
      onFailure={() => {
        void window.kinvue.cancelCapture().catch(() => {
          // Nothing to add: the screen already says it could not be shown.
        })
      }}
      onRetry={() => setAttempt((n) => n + 1)}
    >
      <Dashboard key={attempt} />
    </SectionBoundary>
  )
}

/**
 * Where their usual stands, while it is still learning (KV-17) and once it
 * reaches far back (KV-154). Its own section: both read every record, and a
 * line about the baseline that cannot be worked out must not cost the page
 * (review of #164). Null lines draw nothing — no check-ins, or nothing to say.
 */
function BaselineStatus({ sessions }: { sessions: SessionRecord[] }): React.JSX.Element {
  const learning = useMemo(
    () => learningStatus(sessions, DEMO_PERSON_ID, DEMO_PERSON_NAME),
    [sessions],
  )
  // Measured to when the check-ins last changed, which is when this page last
  // had anything new.
  const reach = useMemo(
    () => usualReachStatus(sessions, DEMO_PERSON_ID, DEMO_PERSON_NAME, new Date()),
    [sessions],
  )
  return (
    <>
      {learning !== null && <p className="mt-3 text-sm">{learning}</p>}
      {reach !== null && <p className="mt-3 text-sm">{reach}</p>}
    </>
  )
}

function Dashboard(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null)
  // The sentence, and which failure it is: an unreadable history is the one
  // that offers a way out (KV-98), so the box needs to know which it is showing.
  const [error, setError] = useState<{ text: string; failure: DashboardFailure } | null>(null)
  // Said once a new history has been started, naming where the old one went.
  const [notice, setNotice] = useState<string | null>(null)
  // A press on a button that touches the store, still in flight. Two presses of
  // "Start a new history" would race in main and put a success and a failure on
  // screen at once (KV-98 review); seeding has the same shape.
  const [busy, setBusy] = useState(false)
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
  // The card whose deletion is being confirmed under it (KV-21), if any.
  const [deleting, setDeleting] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setSessions(await window.kinvue.listSessions(DEMO_PERSON_ID))
    // A list that loaded is the current state of the screen, so an earlier
    // failure to load it is no longer true (KV-95 review). The post-submit
    // sentence is set only after its own refresh has failed, so this never
    // clears it. The new-history notice goes the same way: it describes a
    // moment, and a later reload is a later moment (KV-98 review).
    setError(null)
    setNotice(null)
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
    setBusy(true)
    try {
      let aside: string | null
      try {
        aside = await window.kinvue.startNewHistory()
      } catch (e) {
        // The press failed, but the history is no less unreadable than it was a
        // second ago, so the way out stays on screen (KV-98 review): a file an
        // antivirus scan or a backup held for a moment is free on the next go.
        // A failure that has words of its own — the file turned out to be from
        // a newer version, or could not be opened — says those instead.
        console.error(e)
        const failure = classifyDashboardError(e)
        setError(
          failure === 'unknown'
            ? {
                text:
                  'The old history could not be set aside just now, so nothing was moved. ' +
                  'It is worth another go.',
                failure: 'store-unreadable',
              }
            : { text: dashboardErrorText(e, ''), failure },
        )
        return
      }
      try {
        await refresh()
      } catch (e) {
        // The file was set aside; where it went must not be lost with the list.
        showFailure(
          e,
          aside === null
            ? 'The list could not be reloaded.'
            : `A new, empty history was started and the old file was kept, unchanged, as ${aside}. ` +
                'The list could not be reloaded.',
        )
        return
      }
      setNotice(
        aside === null
          ? 'The history could be read after all, so nothing was moved.'
          : `A new, empty history was started. The old file was kept, unchanged, as ${aside}.`,
      )
    } finally {
      setBusy(false)
    }
  }

  // Two steps that fail differently. Seeding can succeed and the reload after
  // it fail — a sync client briefly holding the file — and "could not be added"
  // would then be false with a fortnight sitting in it (KV-95 review). The
  // submit path makes the same split for the same reason.
  const seed = async (): Promise<void> => {
    setBusy(true)
    try {
      await seedThenReload()
    } finally {
      setBusy(false)
    }
  }

  const seedThenReload = async (): Promise<void> => {
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

  // What each card says, composed as it is shown (KV-138): a real check-in
  // keeps its verdict in today's words, and a seeded day is scored by today's
  // rules (KV-103) — both inside `presentAll`. It rescores the whole history,
  // so it runs when the check-ins change, not on every render: the capture
  // screen's countdown alone re-renders once a second.
  //
  // A record that cannot be presented is its own card's failure, not the
  // page's (review of #164): this runs above every card's boundary, so a throw
  // here once took the whole screen, and "Start a new history" — the one way
  // out of a store the app cannot handle — with it. Its card says it could not
  // be shown; it is never drawn with no presentation, which reads "Not enough
  // to say".
  const [shown, unshown] = useMemo(() => {
    const failed = new Set<string>()
    const map = presentAll(sessions ?? [], (record, e) => {
      console.error(`Check-in ${record.id} could not be presented.`, e)
      failed.add(record.id)
    })
    return [map, failed] as const
  }, [sessions])
  const newest = useMemo(() => [...(sessions ?? [])].reverse(), [sessions])

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
          await refresh().catch((e: unknown) => {
            // The sentence is deliberate (KV-95), but which failure it is still
            // decides whether the way out is offered, and the original is kept.
            console.error(e)
            setError({
              text: 'The check-in was saved, but the list could not be reloaded.',
              failure: classifyDashboardError(e),
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
        {/* A capture screen that cannot be drawn takes its Stop button with it,
            and unmounting it does not stop the camera — only `stopCapture`
            does (review of #164). So the failure stops it, as a press would,
            and the dashboard says what happened. */}
        <SectionBoundary
          fallback="The camera screen could not be shown."
          className=""
          onFailure={() => {
            stopCapture()
            setNotice(
              'The camera screen could not be shown, so the camera was stopped and nothing ' +
                'was recorded. Taking the reading again is worth a try.',
            )
          }}
        >
          <CaptureScreen
            failure={captureFailure}
            onCancel={stopCapture}
            captureSeconds={captureSeconds}
          />
        </SectionBoundary>
      </main>
    )
  }

  if (answering !== null) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* The reading main holds stays submittable for fifteen minutes, and
            questions that cannot be drawn must not make it unreachable — the
            loss "Not now" below goes out of its way to prevent (review of
            #164). It goes back to the dashboard, where "Answer the questions
            anyway" offers it again. */}
        <SectionBoundary
          fallback="The questions could not be shown."
          className=""
          onFailure={() => {
            setReading(answering)
            setAnswering(null)
            setSubmitFailure(null)
            setNotice(
              'The questions could not be shown. The reading is kept below, and answering ' +
                'them again is worth a try.',
            )
          }}
        >
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
        </SectionBoundary>
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
        {sessions !== null && (
          <SectionBoundary
            fallback="Where their usual stands could not be shown."
            className="mt-3"
            resetKey={sessions}
          >
            <BaselineStatus sessions={sessions} />
          </SectionBoundary>
        )}
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
                disabled={busy}
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
            disabled={busy}
            className="mt-4 rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
          >
            Seed demo history
          </button>
        </div>
      )}

      {/* Each section contained on its own (KV-163): one that cannot be drawn
          leaves a sentence in its place, not an empty window. */}
      {sessions !== null && sessions.length > 0 && (
        <SectionBoundary
          fallback={
            'The trend could not be drawn. ' +
            'The check-ins themselves are still saved, and listed below.'
          }
          className={CHART_BOX}
          resetKey={sessions}
        >
          <TrendChart records={sessions} personId={DEMO_PERSON_ID} />
        </SectionBoundary>
      )}

      <div className="space-y-4">
        {newest.map((session) => (
          <SectionBoundary
            key={session.id}
            fallback="This check-in could not be shown. It is still saved, unchanged."
            className={CARD_BOX}
            resetKey={session}
            alreadyFailed={unshown.has(session.id)}
          >
            <SessionCard session={session} presentation={shown.get(session.id) ?? null} />
            {/* Outside the card, which the caregiver's client draws too (KV-34):
                deleting is the person's, at their own device (KV-21). */}
            {deleting === session.id ? (
              <ConfirmRemoval
                sessions={sessions ?? []}
                personId={DEMO_PERSON_ID}
                which={{ kind: 'one', id: session.id }}
                onExport={async () => {
                  try {
                    await window.kinvue.exportHistory(DEMO_PERSON_ID)
                  } catch (e) {
                    showFailure(e, 'The history could not be exported.')
                  }
                }}
                onCancel={() => setDeleting(null)}
                onFailure={(e) =>
                  showFailure(e, 'The check-in could not be deleted. Nothing has been changed.')
                }
                onDone={async (removed) => {
                  setDeleting(null)
                  await refresh()
                  setNotice(
                    removed === 1 ? 'Deleted 1 check-in.' : `Deleted ${String(removed)} check-ins.`,
                  )
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setDeleting(session.id)}
                className="mt-2 text-xs text-(--color-muted) underline-offset-2 hover:underline"
              >
                Delete this check-in&hellip;
              </button>
            )}
          </SectionBoundary>
        ))}
      </div>

      {sessions !== null && (
        <HistoryPanel
          personId={DEMO_PERSON_ID}
          sessions={sessions}
          onChanged={refresh}
          onFailure={showFailure}
        />
      )}
    </main>
  )
}
