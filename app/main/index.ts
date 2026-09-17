import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { scoreSession } from '@core/scoring'
import { createJsonSessionStore } from '@core/session/store'
import { createCheckIn } from '@core/session/checkin'
import type { CaptureResult, SessionRecord } from '@core/session/types'
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
  // Holds each capture until its answers arrive; the rules live in core so they
  // are tested. Everything the renderer sends is validated here first.
  const checkIn = createCheckIn({
    store,
    score: scoreSession,
    now: () => new Date(),
    newId: randomUUID,
  })

  ipcMain.handle('sessions:list', async (_e, personId: unknown): Promise<SessionRecord[]> => {
    const id = parsePersonId(personId)
    if (id === null) throw new Error('sessions:list needs a person id.')
    return await store.list(id)
  })

  ipcMain.handle('checkin:capture', async (event, personId: unknown): Promise<CaptureResult> => {
    const id = parsePersonId(personId)
    if (id === null) throw new Error('checkin:capture needs a person id.')
    return await checkIn.capture(id, () =>
      captureVitals({
        onProgress: (elapsedSec) => {
          // Progress is best-effort: a closed window must not fail the capture.
          if (!event.sender.isDestroyed()) {
            event.sender.send('checkin:progress', elapsedSec)
          }
        },
      }),
    )
  })

  ipcMain.handle(
    'checkin:submit',
    async (_e, personId: unknown, captureId: unknown, answers: unknown): Promise<SessionRecord> => {
      const id = parsePersonId(personId)
      if (id === null) throw new Error('checkin:submit needs a person id.')
      if (typeof captureId !== 'string') throw new Error('checkin:submit needs a capture id.')
      const parsed = parseCheckInAnswers(answers)
      if (parsed === null) throw new Error('checkin:submit received malformed answers.')
      return await checkIn.submit(id, captureId, parsed)
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
