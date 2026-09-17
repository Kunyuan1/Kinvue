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

  /** The reading is held in main for this person; `submit` must name the same one. */
  capture: (personId: string): Promise<CaptureResult> =>
    ipcRenderer.invoke('checkin:capture', personId),

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
}

export type KinvueApi = typeof api

contextBridge.exposeInMainWorld('kinvue', api)
