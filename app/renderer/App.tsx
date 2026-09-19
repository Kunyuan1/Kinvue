import { useCallback, useEffect, useState } from 'react'
import type { CaptureResult, SessionRecord } from '@core/session/types'
import { DEMO_PERSON_ID, DEMO_PERSON_NAME } from '@core/seed/persona'
import CaptureScreen from './components/CaptureScreen'
import SessionCard from './components/SessionCard'

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

  const onCaptured = useCallback((result: CaptureResult): void => {
    // Held, not stored. `submit` takes the captureId once the questions have
    // been answered (KV-2); main keeps the reading until then.
    setReading(result)
    setCapturing(false)
  }, [])

  if (capturing) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <CaptureScreen
          personId={DEMO_PERSON_ID}
          onDone={onCaptured}
          onCancel={() => setCapturing(false)}
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
          onClick={() => {
            setReading(null)
            setCapturing(true)
          }}
          className="rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
        >
          Take a reading
        </button>
        <span className="text-sm text-(--color-muted)">
          About 30 seconds in front of the camera.
        </span>
      </div>

      {reading !== null && (
        <div className="mb-8 rounded-xl border border-(--color-line) bg-(--color-raised) p-5">
          <p className="font-medium">Reading taken</p>
          <p className="mt-1 text-sm text-(--color-muted)">
            Pulse {reading.vitals.pulseRateBpm?.toFixed(0) ?? '—'} bpm · breathing{' '}
            {reading.vitals.breathingRateBrpm?.toFixed(0) ?? '—'} br/min · HRV{' '}
            {reading.vitals.hrvRmssdMs?.toFixed(0) ?? '—'} ms
          </p>
          <p className="mt-2 text-sm text-(--color-muted)">
            It is not a check-in until the questions are answered, which is KV-2. Nothing
            has been saved.
          </p>
        </div>
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
