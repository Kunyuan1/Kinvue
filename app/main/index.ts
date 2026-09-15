import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { scoreSession } from '@core/scoring'
import { createJsonSessionStore } from '@core/session/store'
import type { CheckInAnswers, SessionRecord, Vitals } from '@core/session/types'
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

  ipcMain.handle('sessions:list', async (_e, personId: string): Promise<SessionRecord[]> => {
    return await store.list(personId)
  })

  ipcMain.handle('checkin:capture', async (event): Promise<Vitals> => {
    return await captureVitals({
      onProgress: (elapsedSec) => {
        // Progress is best-effort: a closed window must not fail the capture.
        if (!event.sender.isDestroyed()) {
          event.sender.send('checkin:progress', elapsedSec)
        }
      },
    })
  })

  ipcMain.handle(
    'checkin:submit',
    async (_e, personId: string, vitals: Vitals, answers: CheckInAnswers): Promise<SessionRecord> => {
      const history = await store.list(personId)
      const session: SessionRecord = {
        id: `s-${Date.now()}`,
        personId,
        capturedAt: new Date().toISOString(),
        vitals,
        answers,
      }
      // Scored against prior sessions only — the new one must not be in its
      // own baseline. See core/baseline.
      session.assessment = scoreSession(session, history)
      await store.append(session)
      return session
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
