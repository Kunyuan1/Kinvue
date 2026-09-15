import { useCallback, useEffect, useState } from 'react'
import type { SessionRecord } from '@core/session/types'
import { DEMO_PERSON_ID, DEMO_PERSON_NAME } from '@core/seed/persona'
import SessionCard from './components/SessionCard'

/**
 * The caregiver's view. This app is not used by the person being checked on —
 * every string on this screen is addressed to whoever looks after them, which
 * is the framing the whole product hangs on. Keep it that way.
 *
 * SCAFFOLD (KV-2/KV-3/KV-4): the session list and per-session explanation are
 * real. The check-in question flow and the trend view are their own tickets;
 * the capture button below wires the IPC but has no questions in front of it
 * yet, and capture itself is blocked on KV-1.
 */
export default function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">{DEMO_PERSON_NAME}&rsquo;s check-ins</h1>
        <p className="mt-1 text-sm text-(--color-muted)">
          A daily look at whether today is different from {DEMO_PERSON_NAME}&rsquo;s own
          usual. Not a diagnosis, and not an emergency alert.
        </p>
      </header>

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
