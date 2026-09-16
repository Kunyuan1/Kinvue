import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { scoreSession } from '@core/scoring'
import { createJsonSessionStore } from '@core/session/store'
import type { CaptureResult, SessionRecord, Vitals } from '@core/session/types'
import { parseCheckInAnswers, parsePersonId } from '@core/session/validate'
import { DEMO_PERSON_ID, seedDemoHistory } from '@core/seed/persona'
import { captureVitals } from './vitals'

/**
 * Main process: owns the camera, the API key and the session file. The renderer
 * owns none of those and reaches all three over the narrow IPC surface below.
 * The API key in particular never crosses into the renderer.
 */

// Under Electron's userData, so real check-ins live outside the repo. The
// repo's .gitignore also covers sessions/ for anyone who points this at ./.
const storePath = (): string => join(app.getPath('userData'), 'sessions', 'sessions.json')

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerIpc(): void {
  const store = createJsonSessionStore(storePath())

  // The latest capture, held here until its answers arrive. Vitals never make
  // the round trip through the renderer: a renderer that could submit vitals
  // could submit numbers no camera produced. See ARCHITECTURE.md.
  let pending: { captureId: string; capturedAt: string; vitals: Vitals } | null = null
  let capturing = false

  ipcMain.handle('sessions:list', async (_e, personId: unknown): Promise<SessionRecord[]> => {
    const id = parsePersonId(personId)
    if (id === null) throw new Error('sessions:list needs a person id.')
    return await store.list(id)
  })

  ipcMain.handle('checkin:capture', async (event): Promise<CaptureResult> => {
    // One camera, one capture. A second SDK instance on the same device is not
    // a second reading, it is two broken ones.
    if (capturing) throw new Error('A capture is already running.')
    capturing = true
    // A new capture supersedes any unsubmitted one, so a stale id cannot be
    // submitted against answers given after a newer reading.
    pending = null
    const capturedAt = new Date().toISOString()
    try {
      const vitals = await captureVitals({
        onProgress: (elapsedSec) => {
          // Progress is best-effort: a closed window must not fail the capture.
          if (!event.sender.isDestroyed()) {
            event.sender.send('checkin:progress', elapsedSec)
          }
        },
      })
      const captureId = randomUUID()
      pending = { captureId, capturedAt, vitals }
      return { captureId, vitals }
    } finally {
      capturing = false
    }
  })

  ipcMain.handle(
    'checkin:submit',
    async (_e, personId: unknown, captureId: unknown, answers: unknown): Promise<SessionRecord> => {
      const id = parsePersonId(personId)
      if (id === null) throw new Error('checkin:submit needs a person id.')
      const parsed = parseCheckInAnswers(answers)
      if (parsed === null) throw new Error('checkin:submit received malformed answers.')
      if (pending === null || pending.captureId !== captureId) {
        throw new Error(
          'No matching capture to submit — it was already submitted, or a newer capture replaced it.',
        )
      }

      // Taken before any await, so a double submit cannot store the capture twice.
      const capture = pending
      pending = null

      try {
        const history = await store.list(id)
        const session: SessionRecord = {
          // Not derived from the clock: ids must stay unique once records from
          // more than one device meet.
          id: randomUUID(),
          personId: id,
          capturedAt: capture.capturedAt,
          vitals: capture.vitals,
          answers: parsed,
        }
        // Scored against prior sessions only — the new one must not be in its
        // own baseline. See core/baseline.
        session.assessment = scoreSession(session, history)
        await store.append(session)
        return session
      } catch (err) {
        // Nothing was stored, so the reading is still theirs to submit.
        pending ??= capture
        throw err
      }
    },
  )

  // KV-8. Opt-in, and every record it writes is marked `seeded: true`.
  ipcMain.handle('demo:seed', async (): Promise<number> => {
    const existing = await store.list(DEMO_PERSON_ID)
    if (existing.length > 0) return 0
    const seeded = seedDemoHistory()
    for (const record of seeded) await store.append(record)
    return seeded.length
  })
}

void app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
