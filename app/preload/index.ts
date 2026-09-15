import { contextBridge, ipcRenderer } from 'electron'
import type { CheckInAnswers, SessionRecord, Vitals } from '@core/session/types'

/**
 * The entire surface the renderer gets. Everything is a named call — no generic
 * `invoke(channel, ...)` passthrough, which would hand the renderer the whole
 * main process if any renderer code were ever compromised.
 */
const api = {
  listSessions: (personId: string): Promise<SessionRecord[]> =>
    ipcRenderer.invoke('sessions:list', personId),

  capture: (): Promise<Vitals> => ipcRenderer.invoke('checkin:capture'),

  submit: (personId: string, vitals: Vitals, answers: CheckInAnswers): Promise<SessionRecord> =>
    ipcRenderer.invoke('checkin:submit', personId, vitals, answers),

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
