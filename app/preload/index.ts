import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureResult, CheckInAnswers, SessionRecord } from '@core/session/types'
import type { Removal, RestoreResult, RestoreStep } from '@core/session/lifecycle'
import type { Protection } from '../shared/protection'
import type { CameraAccess } from '../shared/camera-access'
import { fromCaptureReply } from '../shared/capture-reply'

/**
 * The entire surface the renderer gets. Everything is a named call — no generic
 * `invoke(channel, ...)` passthrough, which would hand the renderer the whole
 * main process if any renderer code were ever compromised.
 */
const api = {
  listSessions: (personId: string): Promise<SessionRecord[]> =>
    ipcRenderer.invoke('sessions:list', personId),

  /**
   * How long a capture runs. Asked for rather than assumed, so the countdown
   * and the sentence under the button cannot drift from what main will do
   * (#63).
   */
  captureSeconds: (): Promise<number> => ipcRenderer.invoke('capture:seconds'),

  /**
   * The reading is held in main for this person; `submit` must name the same one.
   *
   * A stop arrives as a reply, not a rejection, so main does not log it as a
   * fault; it is turned back into the tagged rejection here (KV-89).
   */
  capture: (personId: string): Promise<CaptureResult> =>
    ipcRenderer.invoke('checkin:capture', personId).then(fromCaptureReply),

  /**
   * Abandons a running capture and releases the camera. The person in front of
   * it decides when being filmed stops (KV-3).
   */
  cancelCapture: (): Promise<void> => ipcRenderer.invoke('checkin:cancel'),

  /** Takes the id from `capture`, never the vitals — see core/session/checkin.ts. */
  submit: (personId: string, captureId: string, answers: CheckInAnswers): Promise<SessionRecord> =>
    ipcRenderer.invoke('checkin:submit', personId, captureId, answers),

  seedDemo: (): Promise<number> => ipcRenderer.invoke('demo:seed'),

  /**
   * Sets an unreadable history aside and starts an empty one (KV-98). Resolves
   * to where the old file now is, or null when there was nothing to set aside.
   */
  startNewHistory: (): Promise<string | null> => ipcRenderer.invoke('sessions:startNewHistory'),

  /**
   * Where the history's protection stands (KV-175): encrypted with this
   * computer's key, waiting for that key to reach the disk, or no key store.
   */
  historyProtection: (): Promise<Protection> => ipcRenderer.invoke('store:protection'),

  /** Whether Windows lets Kinvue use the camera at all (KV-19): the setup screen's question. */
  cameraAccess: (): Promise<CameraAccess> => ipcRenderer.invoke('setup:camera'),

  /** Opens Windows's camera privacy settings, where the switch is turned on. */
  openCameraSettings: (): Promise<void> => ipcRenderer.invoke('setup:openCameraSettings'),

  /** When this person's history was last exported, or null for never (KV-21). */
  lastExported: (personId: string): Promise<string | null> =>
    ipcRenderer.invoke('history:lastExported', personId),

  /**
   * Asks where to save, then writes a restorable export there (KV-21) —
   * protected with `passphrase` when one is given (KV-175). Resolves to how
   * many check-ins it holds, or null when the person cancelled.
   */
  exportHistory: (
    personId: string,
    passphrase?: string,
  ): Promise<{ count: number; protected: boolean } | null> =>
    ipcRenderer.invoke('history:export', personId, passphrase),

  /**
   * Asks which file, then restores it: everything it accepts, or nothing
   * (KV-21). For a protected export, asks for its passphrase instead (KV-175).
   * Null when the person cancelled.
   */
  restoreHistory: (personId: string): Promise<RestoreStep | null> =>
    ipcRenderer.invoke('history:restore', personId),

  /** Opens the protected export waiting in main with `passphrase`, and restores it. */
  restoreProtected: (personId: string, passphrase: string): Promise<RestoreResult> =>
    ipcRenderer.invoke('history:restoreProtected', personId, passphrase),

  /** Lets go of a protected export waiting for its passphrase. */
  cancelRestore: (): Promise<void> => ipcRenderer.invoke('history:cancelRestore'),

  /** Deletes the check-ins `which` names, keeping tombstones. Resolves to how many. */
  removeCheckIns: (personId: string, which: Removal): Promise<number> =>
    ipcRenderer.invoke('history:remove', personId, which),

  /** Returns an unsubscribe function. */
  onCaptureProgress: (fn: (elapsedSec: number) => void): (() => void) => {
    const listener = (_e: unknown, elapsedSec: number): void => fn(elapsedSec)
    ipcRenderer.on('checkin:progress', listener)
    return () => ipcRenderer.off('checkin:progress', listener)
  },

  /**
   * Fired once when every metric has arrived and the capture is finishing up,
   * so the countdown stops promising seconds it will not use (#63). Returns an
   * unsubscribe function.
   */
  onCaptureSettling: (fn: () => void): (() => void) => {
    const listener = (): void => fn()
    ipcRenderer.on('checkin:settling', listener)
    return () => ipcRenderer.off('checkin:settling', listener)
  },

  /**
   * What the person should do differently, in their words — "sit back a
   * little", "too dark" — or null when the shot is fine again and whatever is
   * on screen should go. Main decides when advice is worth showing and when it
   * stops being true; this carries it. Returns an unsubscribe function.
   */
  onCaptureGuidance: (fn: (message: string | null) => void): (() => void) => {
    const listener = (_e: unknown, message: string | null): void => fn(message)
    ipcRenderer.on('checkin:guidance', listener)
    return () => ipcRenderer.off('checkin:guidance', listener)
  },

  /**
   * JPEG frames of what the camera sees, for the person's own self-view, about
   * ten a second while a capture runs. Display only — nothing stores them, and
   * the renderer cannot ask for them, only listen. Returns an unsubscribe.
   */
  onCaptureFrame: (fn: (jpeg: Uint8Array | null) => void): (() => void) => {
    // null means this camera's frames cannot be shown, so the screen can say so
    // rather than wait for a picture that is never coming.
    const listener = (_e: unknown, jpeg: Uint8Array | null): void => fn(jpeg)
    ipcRenderer.on('checkin:frame', listener)
    return () => ipcRenderer.off('checkin:frame', listener)
  },
}

export type KinvueApi = typeof api

contextBridge.exposeInMainWorld('kinvue', api)
