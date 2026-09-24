// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from '@renderer/App'
import { UnreachableStoreError, UnreadableStoreError } from '@core/session/store'
import type { SessionRecord } from '@core/session/types'
import { session } from './helpers'

/**
 * What the dashboard's error box says, from the call sites that decide it
 * (KV-95). `dashboardErrorText` is tested on its own in `failure.test.ts`; this
 * is the part that picks *which* fallback a caregiver reads, and when the box
 * goes away — the half the first version of #115 left unreached.
 *
 * The bridge is stubbed with only what `App` calls on the way to these states.
 * Rejections are shaped the way Electron delivers a failed `invoke`.
 */
const PATH = String.raw`C:\Users\someone\AppData\Roaming\kinvue\sessions\sessions.json`
const fromMain = (err: Error, channel: string): Error =>
  new Error(`Error invoking remote method '${channel}': ${String(err)}`)

let listSessions: ReturnType<typeof vi.fn<() => Promise<SessionRecord[]>>>
let seedDemo: ReturnType<typeof vi.fn<() => Promise<number>>>
let startNewHistory: ReturnType<typeof vi.fn<() => Promise<string | null>>>

beforeEach(() => {
  listSessions = vi.fn<() => Promise<SessionRecord[]>>()
  seedDemo = vi.fn<() => Promise<number>>()
  startNewHistory = vi.fn<() => Promise<string | null>>()
  Object.defineProperty(window, 'kinvue', {
    configurable: true,
    value: {
      listSessions,
      seedDemo,
      startNewHistory,
      captureSeconds: vi.fn(() => Promise.resolve(90)),
      cancelCapture: vi.fn(() => Promise.resolve()),
    },
  })
  // The dashboard logs the original of anything it will not show.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the dashboard when the history cannot be shown', () => {
  it("shows only the store's sentence for an unreadable history", async () => {
    listSessions.mockRejectedValue(
      fromMain(new UnreadableStoreError(PATH, 'it is not valid JSON'), 'sessions:list'),
    )
    render(<App />)

    expect(await screen.findByText(/could not be read: it is not valid JSON/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/invoking remote method|StoreError|kinvue\//)
  })

  it('names a history that could not be opened, rather than leaving the list empty and silent', async () => {
    listSessions.mockRejectedValue(
      fromMain(new UnreachableStoreError(PATH, 'EACCES', new Error('denied')), 'sessions:list'),
    )
    render(<App />)

    expect(await screen.findByText(/could not be opened \(EACCES\)/)).toBeTruthy()
  })

  it('says the list could not be shown for anything else, and logs the original', async () => {
    listSessions.mockRejectedValue(fromMain(new Error('something odd'), 'sessions:list'))
    render(<App />)

    expect(await screen.findByText('The check-ins could not be shown.')).toBeTruthy()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('seeding the demo', () => {
  it('does not say the demo was not added when only the reload after it failed', async () => {
    // Seeding wrote the fortnight; the list that follows is what failed.
    listSessions
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(fromMain(new Error('EBUSY-ish'), 'sessions:list'))
    seedDemo.mockResolvedValue(12)
    render(<App />)

    fireEvent.click(await screen.findByText('Seed demo history'))

    expect(
      await screen.findByText('The demo history was added, but the list could not be reloaded.'),
    ).toBeTruthy()
    expect(screen.queryByText('The demo history could not be added.')).toBeNull()
  })

  it('says it could not be added when seeding itself failed', async () => {
    listSessions.mockResolvedValue([])
    seedDemo.mockRejectedValue(fromMain(new Error('disk full'), 'demo:seed'))
    render(<App />)

    fireEvent.click(await screen.findByText('Seed demo history'))

    expect(await screen.findByText('The demo history could not be added.')).toBeTruthy()
  })

  it('clears the error once the list loads, so it never sits above the check-ins it denies', async () => {
    listSessions.mockResolvedValueOnce([]).mockResolvedValue([session({ id: 'after' })])
    seedDemo.mockRejectedValueOnce(fromMain(new Error('disk full'), 'demo:seed'))
    seedDemo.mockResolvedValueOnce(1)
    render(<App />)

    fireEvent.click(await screen.findByText('Seed demo history'))
    await screen.findByText('The demo history could not be added.')

    fireEvent.click(screen.getByText('Seed demo history'))
    await screen.findByText(/Looks normal|Not enough to say/)
    expect(screen.queryByText('The demo history could not be added.')).toBeNull()
  })
})

describe('starting a new history (KV-98)', () => {
  const unreadable = (): Error =>
    fromMain(new UnreadableStoreError(PATH, 'it is not valid JSON'), 'sessions:list')

  it('is offered for an unreadable history, and says the old file is kept', async () => {
    listSessions.mockRejectedValue(unreadable())
    render(<App />)

    expect(await screen.findByText('Start a new history')).toBeTruthy()
    expect(document.body.textContent).toMatch(/Nothing in the old file is deleted/)
  })

  it('is not offered for a history that could not be opened, or for anything else', async () => {
    listSessions.mockRejectedValue(
      fromMain(new UnreachableStoreError(PATH, 'EBUSY', new Error('busy')), 'sessions:list'),
    )
    render(<App />)
    await screen.findByText(/could not be opened \(EBUSY\)/)
    expect(screen.queryByText('Start a new history')).toBeNull()

    cleanup()
    listSessions.mockRejectedValue(fromMain(new Error('odd'), 'sessions:list'))
    render(<App />)
    await screen.findByText('The check-ins could not be shown.')
    expect(screen.queryByText('Start a new history')).toBeNull()
  })

  it('sets the file aside on the press, clears the error, and names where the old file went', async () => {
    listSessions.mockRejectedValueOnce(unreadable()).mockResolvedValue([])
    startNewHistory.mockResolvedValue(`${PATH}.unreadable-2026-09-22`)
    render(<App />)

    fireEvent.click(await screen.findByText('Start a new history'))

    expect(await screen.findByText(/kept, unchanged, as .*unreadable-2026-09-22/)).toBeTruthy()
    expect(startNewHistory).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/could not be read/)).toBeNull()
    // Empty now, so the demo can be seeded again.
    expect(screen.getByText('Seed demo history')).toBeTruthy()
  })

  it('just loads the history when it has become readable in the meantime', async () => {
    // Main found nothing to set aside, so there is no "new history" to claim.
    listSessions.mockRejectedValueOnce(unreadable()).mockResolvedValue([session({ id: 'kept' })])
    startNewHistory.mockResolvedValue(null)
    render(<App />)

    fireEvent.click(await screen.findByText('Start a new history'))

    await screen.findByText(/Looks normal|Not enough to say/)
    expect(screen.queryByText(/new, empty history/)).toBeNull()
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })

  it('says so, and moves nothing it has not been told about, when starting one fails', async () => {
    listSessions.mockRejectedValue(unreadable())
    startNewHistory.mockRejectedValue(fromMain(new Error('EPERM'), 'sessions:startNewHistory'))
    render(<App />)

    fireEvent.click(await screen.findByText('Start a new history'))

    expect(await screen.findByText('A new history could not be started.')).toBeTruthy()
  })
})
