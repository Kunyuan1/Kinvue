import { classifyDashboardError, failureDetail } from '@core/capture/failure'

/**
 * What the dashboard's error box says when the check-in list cannot be shown
 * or the demo cannot be seeded (KV-95).
 *
 * It used to show `String(error)`, which for an unreadable history read
 * "Error: Error invoking remote method 'sessions:list': UnreadableStoreError:
 * kinvue/store-unreadable: The check-in history at …" — the one sentence
 * written for the caregiver, behind three layers of transport. That sentence is
 * now shown on its own. Anything the dashboard has no words for gets `fallback`,
 * a plain sentence from the call site, and the caller logs the original: the
 * detail a developer needs belongs in the console, not in front of a caregiver.
 *
 * Kept out of `App.tsx` and free of React so the suite can reach it without a
 * DOM.
 */
export function dashboardErrorText(error: unknown, fallback: string): string {
  if (classifyDashboardError(error) === 'store-unreadable') {
    return failureDetail(error, 'store-unreadable') ?? STORE_UNREADABLE
  }
  return fallback
}

/**
 * Only for a tagged error that somehow carries no sentence. The store always
 * writes one, so this is a floor, not the expected path.
 */
const STORE_UNREADABLE =
  'The saved check-in history could not be opened. Nothing in it has been changed.'
