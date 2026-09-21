import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureResult, CheckInAnswers, SessionRecord } from '@core/session/types'

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

  /** The reading is held in main for this person; `submit` must name the same one. */
  capture: (personId: string): Promise<CaptureResult> =>
    ipcRenderer.invoke('checkin:capture', personId),

  /**
   * Abandons a running capture and releases the camera. The person in front of
   * it decides when being filmed stops (KV-3).
   */
  cancelCapture: (): Promise<void> => ipcRenderer.invoke('checkin:cancel'),

  /** Takes the id from `capture`, never the vitals — see core/session/checkin.ts. */
  submit: (personId: string, captureId: string, answers: CheckInAnswers): Promise<SessionRecord> =>
    ipcRenderer.invoke('checkin:submit', personId, captureId, answers),

  seedDemo: (): Promise<number> => ipcRenderer.invoke('demo:seed'),

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
