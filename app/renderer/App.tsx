import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureResult, SessionRecord } from '@core/session/types'
import { DEMO_PERSON_ID, DEMO_PERSON_NAME } from '@core/seed/persona'
import type { CheckInAnswers } from '@core/session/types'
import CaptureScreen from './components/CaptureScreen'
import QuestionFlow from './components/QuestionFlow'
import SessionCard from './components/SessionCard'

/**
 * What to put in front of the person when a capture fails.
 *
 * `String(e)` on an IPC rejection reads "Error: Error invoking remote method
 * 'checkin:capture': Error: …" — and for a missing key, a registration URL and
 * instructions about a dotfile. That is a developer's error message on the one
 * screen addressed to the person being measured, so the known cases are put
 * into this screen's voice and anything else is kept short.
 */
function readable(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)

  if (raw.includes('already running')) {
    return 'The camera is still finishing the last reading. Try again in a moment.'
  }
  if (raw.includes('SMARTSPECTRA_API_KEY')) {
    return 'This copy of Kinvue is not set up to use the camera yet.'
  }
  if (raw.includes('stopped')) return 'The reading was stopped.'
  if (raw.includes('too old')) {
    return 'Too long has passed since the reading was taken. Please take a new one.'
  }
  if (raw.includes('No matching capture') || raw.includes('not the latest capture')) {
    return 'That reading is no longer available. Please take a new one.'
  }
  if (raw.includes('malformed answers')) return 'Those answers could not be saved.'
  return 'The camera could not be started.'
}

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
  const measured = [
    pulseRateBpm === null ? null : `pulse ${pulseRateBpm.toFixed(0)} bpm`,
    breathingRateBrpm === null ? null : `breathing ${breathingRateBrpm.toFixed(0)} br/min`,
    hrvRmssdMs === null ? null : `HRV ${hrvRmssdMs.toFixed(0)} ms`,
  ].filter((part): part is string => part !== null)

  return (
    <div className="mb-8 rounded-xl border border-(--color-line) bg-(--color-raised) p-5">
      {measured.length === 0 ? (
        <>
          <p className="font-medium text-(--color-unknown)">Nothing was measured</p>
          <p className="mt-1 text-sm text-(--color-muted)">
            The camera ran, but no reading came out of it. That usually means the framing
            was not right for long enough — the face centred, chest in view, reasonably
            lit, and still. Worth another try.
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">Reading taken</p>
          <p className="mt-1 text-sm text-(--color-muted)">{measured.join(' · ')}</p>
          {measured.length < 3 && (
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
      {/* Storing a check-in whose camera reading failed is the honest outcome —
          the questions were still answered, and the verdict says the reading
          could not be used. Whether that is the policy, rather than this
          person's choice each time, is KV-7. */}
    </div>
  )
}

/**
 * The caregiver's view. This app is not used by the person being checked on —
 * every string on this screen is addressed to whoever looks after them, which
 * is the framing the whole product hangs on. Keep it that way.
 *
 * SCAFFOLD (KV-2/KV-4): the session list, the per-session explanation and the
 * capture itself are real. What is missing is the four questions that turn a
 * reading into a check-in (KV-2) and the trend view (KV-4) — so a capture
 * taken here is shown and then discarded, because a session cannot be stored
 * without answers.
 */
export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [answering, setAnswering] = useState<CaptureResult | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const captureGeneration = useRef(0)
  const [reading, setReading] = useState<CaptureResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setSessions(await window.kinvue.listSessions(DEMO_PERSON_ID))
  }, [])

  useEffect(() => {
    void refresh().catch((e: unknown) => setError(String(e)))
  }, [refresh])

  const seed = async (): Promise<void> => {
    await window.kinvue.seedDemo()
    await refresh()
  }

  const newest = sessions === null ? [] : [...sessions].reverse()

  /**
   * Started here, on the press, rather than inside the capture screen. Opening
   * the camera cannot be undone, and React runs an effect twice in development
   * — which asked main for two captures and had the second refused.
   */
  const startCapture = useCallback((): void => {
    setReading(null)
    setCaptureError(null)
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
        const measuredNothing =
          result.vitals.pulseRateBpm === null &&
          result.vitals.breathingRateBrpm === null &&
          result.vitals.hrvRmssdMs === null
        if (measuredNothing) setReading(result)
        else setAnswering(result)
      })
      .catch((e: unknown) => {
        if (started !== captureGeneration.current) return
        setCaptureError(readable(e))
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
      setSubmitError(null)

      window.kinvue
        .submit(DEMO_PERSON_ID, answering.captureId, answers)
        .then(async () => {
          setAnswering(null)
          setReading(null)
          setSubmitting(false)
          await refresh()
        })
        .catch((e: unknown) => {
          setSubmitting(false)
          setSubmitError(readable(e))
        })
    },
    [answering, refresh],
  )

  if (capturing) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <CaptureScreen error={captureError} onCancel={stopCapture} />
      </main>
    )
  }

  if (answering !== null) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <QuestionFlow
          onDone={submit}
          onCancel={() => {
            // The reading is left unsubmitted in main, where it expires on its
            // own. Nothing is stored, which is the honest outcome of a check-in
            // someone chose not to finish.
            setAnswering(null)
            setSubmitError(null)
          }}
          submitting={submitting}
          error={submitError}
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
          About 30 seconds in front of the camera.
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
        <p className="mb-6 rounded-lg border border-(--color-line) p-4 text-sm text-(--color-elevated)">
          {error}
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
            onClick={() => void seed().catch((e: unknown) => setError(String(e)))}
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
