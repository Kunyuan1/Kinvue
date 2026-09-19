import { failureTag } from '../capture/failure'
import type { SessionStore } from './store'
import type { Assessment, CaptureResult, CheckInAnswers, SessionRecord, Vitals } from './types'

/**
 * The state a check-in holds between its capture and its answers, and the
 * rules for turning the two into one stored session.
 *
 * Vitals never make the round trip through the renderer: a renderer that could
 * submit vitals could submit numbers no camera produced. Main holds the reading
 * here and the renderer holds only its `captureId`. See ARCHITECTURE.md.
 *
 * Kept free of Electron, and of the store's and the camera's implementations,
 * so these rules are tested without a harness. `app/main` only wires them to IPC.
 */

/**
 * How long a reading can wait for its answers. The answers are about how the
 * person is right now, so a reading left over lunch — or overnight — must not
 * be stored alongside them as one check-in. Generous enough for someone slow
 * to answer four questions; checked in main, where the renderer cannot skip it.
 */
export const PENDING_CAPTURE_TTL_MS = 15 * 60 * 1000

export interface CheckInDeps {
  store: Pick<SessionStore, 'list' | 'append'>
  score: (session: SessionRecord, history: readonly SessionRecord[]) => Assessment
  now: () => Date
  newId: () => string
  /**
   * The device's IANA time zone, read when a capture starts, or undefined when
   * the device cannot say. Injected rather than read here so the rules stay
   * testable, and captured with the reading rather than with the answers: a
   * check-in taken at 23:50 and submitted at 00:05 belongs to the day it was
   * taken (KV-28).
   */
  timeZone: () => string | undefined
}

export interface CheckIn {
  /** Run `measure` and hold its reading for `personId` until it is submitted. */
  capture(personId: string, measure: () => Promise<Vitals>): Promise<CaptureResult>
  /** Score and store the held reading with these answers. Inputs must already be validated. */
  submit(personId: string, captureId: string, answers: CheckInAnswers): Promise<SessionRecord>
}

interface Held {
  captureId: string
  personId: string
  capturedAt: string
  timeZone: string | undefined
  vitals: Vitals
}

export function createCheckIn(deps: CheckInDeps): CheckIn {
  let pending: Held | null = null
  // The newest successful capture, submitted or not. A reading is only ever
  // submittable while it is this one.
  let latestCaptureId: string | null = null
  // The reading whose TTL ran out, remembered so that pressing Save twice
  // gives one answer rather than two. Without it the second press falls
  // through to "that is not the latest capture", and one state has told the
  // person two different things.
  let expiredCaptureId: string | null = null
  let capturing = false

  return {
    async capture(personId, measure) {
      // One camera, one capture. A second SDK instance on the same device is not
      // a second reading, it is two broken ones.
      if (capturing) {
        throw new Error(`${failureTag('capture-in-progress')}: a capture is already running.`)
      }
      // Both read before the lock is taken. `now()` cannot throw, but reading a
      // zone can — and a throw after `capturing = true` would leave the lock set
      // for the life of the process, so every later capture would fail with "a
      // capture is already running" about a camera nothing is using.
      const capturedAt = deps.now().toISOString()
      const timeZone = deps.timeZone()
      capturing = true
      try {
        // The previous reading stays submittable until this one succeeds. A
        // retake that fails (camera busy, SDK error) must not throw away a good
        // reading the person is still looking at.
        const vitals = await measure()
        const captureId = deps.newId()
        pending = { captureId, personId, capturedAt, timeZone, vitals }
        latestCaptureId = captureId
        return { captureId, vitals }
      } finally {
        capturing = false
      }
    },

    async submit(personId, captureId, answers) {
      if (captureId === expiredCaptureId) {
        throw new Error(
          `${failureTag('expired')}: that capture is too old to go with answers given now.`,
        )
      }
      if (captureId !== latestCaptureId) {
        throw new Error(
          `${failureTag('no-capture')}: that is not the latest capture — a newer one replaced ` +
            'it, or it never existed.',
        )
      }
      if (pending === null) {
        throw new Error(
          `${failureTag('no-capture')}: that capture has already been submitted, or has expired.`,
        )
      }
      // Rejected, not refiled: a reading scored against someone else's history
      // would also enter their baseline for good.
      if (pending.personId !== personId) {
        throw new Error(`${failureTag('no-capture')}: that capture was taken for a different person.`)
      }
      if (deps.now().getTime() - Date.parse(pending.capturedAt) > PENDING_CAPTURE_TTL_MS) {
        pending = null
        expiredCaptureId = captureId
        throw new Error(
          `${failureTag('expired')}: that capture is too old to go with answers given now.`,
        )
      }

      // Taken before any await, so a double submit cannot store the capture twice.
      const held = pending
      pending = null

      try {
        const history = await deps.store.list(personId)
        const session: SessionRecord = {
          // Not derived from the clock: ids must stay unique once records from
          // more than one device meet.
          id: deps.newId(),
          personId,
          capturedAt: held.capturedAt,
          vitals: held.vitals,
          answers,
        }
        // Set only when the device could say: a record with no zone is honest,
        // a record with a guessed one is not (KV-28).
        if (held.timeZone !== undefined) session.timeZone = held.timeZone
        // Scored against prior sessions only — the new one must not be in its
        // own baseline. See core/baseline.
        session.assessment = deps.score(session, history)
        await deps.store.append(session)
        return session
      } catch (err) {
        // Nothing was stored, so the reading is still theirs to submit — unless
        // a newer capture succeeded in the meantime, which replaces it and must
        // not be overwritten here. (`submit` rejects a superseded id anyway;
        // this keeps the held reading from going stale behind it.)
        if (latestCaptureId === held.captureId) pending = held
        throw err
      }
    },
  }
}
