import {
  classifyDashboardError,
  failureDetail,
  type DashboardFailure,
} from '@core/capture/failure'

/**
 * What to say for a store failure that somehow arrives without its sentence.
 *
 * Keyed by every dashboard failure that has words of its own, so adding one to
 * `DashboardFailure` does not compile until it has a floor here — the same
 * guarantee the capture and submit screens get from their copy tables. The
 * store always writes a sentence, so these are floors, not the expected path.
 */
const FLOOR: Record<Exclude<DashboardFailure, 'unknown'>, string> = {
  'store-unreadable':
    'The saved check-in history could not be read. Nothing in it has been changed.',
  'store-unreachable':
    'The saved check-in history could not be opened. Another program may be using it, ' +
    'or its permissions may need checking. Nothing has been changed.',
}

/**
 * What the dashboard's error box says when the check-in list cannot be shown
 * or the demo cannot be seeded (KV-95).
 *
 * It used to show `String(error)`, which for an unreadable history read
 * "Error: Error invoking remote method 'sessions:list': UnreadableStoreError:
 * kinvue/store-unreadable: The check-in history at …" — the one sentence
 * written for the caregiver, behind three layers of transport. A store failure
 * now shows its own sentence alone. Anything the dashboard has no words for
 * gets `fallback`, a plain sentence from the call site, and the caller logs the
 * original.
 *
 * `classifyDashboardError` picks the *earliest* tag in the text and
 * `failureDetail` reads the sentence after *this* tag. They agree whenever one
 * error carries one tag, which is every store error; were a message ever to
 * quote a second, the earliest — written by the code that threw — decides both.
 *
 * Kept out of `App.tsx` and free of React so the suite can reach it without a
 * DOM.
 */
export function dashboardErrorText(error: unknown, fallback: string): string {
  const failure = classifyDashboardError(error)
  if (failure === 'unknown') return fallback
  return failureDetail(error, failure) ?? FLOOR[failure]
}
