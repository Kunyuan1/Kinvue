// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from '@renderer/App'
import SectionBoundary from '@renderer/components/SectionBoundary'
import {
  NewerStoreError,
  UnreachableStoreError,
  UnreadableStoreError,
} from '@core/session/store'
import type { SessionRecord } from '@core/session/types'
import { scoreSession } from '@core/scoring'
import { history, session } from './helpers'
import { DEMO_PERSON_ID, DEMO_PERSON_NAME } from '@core/seed/persona'

/**
 * A card, or the chart, that can be made to throw while drawing (KV-163).
 *
 * Both delegate to the real component, so every other test here draws them
 * as they are. A throw of our own, rather than a record crafted to break one:
 * whatever breaks one today gets fixed, as `knownZone` fixed the last one, and
 * the test would quietly stop exercising anything.
 */
const drawControl = vi.hoisted(() => ({
  cardThrowsFor: null as string | null,
  chartThrows: false,
  presentThrows: false,
  captureThrows: false,
  questionsThrow: false,
}))

// The capture and question screens, as stand-ins: the real capture screen
// subscribes to the preload's capture events, which this bridge does not stub,
// and `failure-screens.test.tsx` draws both for real. Here only whether they
// throw matters (review of #164).
vi.mock('@renderer/components/CaptureScreen', () => ({
  default: () => {
    if (drawControl.captureThrows) throw new Error('capture screen failed to draw')
    return <p>in front of the camera</p>
  },
}))

vi.mock('@renderer/components/QuestionFlow', () => ({
  default: () => {
    if (drawControl.questionsThrow) throw new Error('questions failed to draw')
    return <p>the questions</p>
  },
}))

// A throw in the screen's own code: `presentAll` mocked to throw outright,
// above every section, whatever it is handed.
vi.mock('@core/scoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/scoring')>()
  return {
    ...actual,
    presentAll: (...args: Parameters<typeof actual.presentAll>) => {
      if (drawControl.presentThrows) throw new Error('scoring failed while drawing')
      return actual.presentAll(...args)
    },
  }
})

// Rendered as elements, not called: a call would run the real component's
// hooks on the wrapper's fiber, and the first conditional hook in either would
// break every test here with an error pointing at the mock (review of #164).
vi.mock('@renderer/components/SessionCard', async (importOriginal) => {
  const { default: Real } = await importOriginal<typeof import('@renderer/components/SessionCard')>()
  return {
    default: (props: Parameters<typeof Real>[0]) => {
      if (props.session.id === drawControl.cardThrowsFor) throw new Error('card failed to draw')
      return <Real {...props} />
    },
  }
})

vi.mock('@renderer/components/TrendChart', async (importOriginal) => {
  const { default: Real } = await importOriginal<typeof import('@renderer/components/TrendChart')>()
  return {
    default: (props: Parameters<typeof Real>[0]) => {
      if (drawControl.chartThrows) throw new Error('chart failed to draw')
      return <Real {...props} />
    },
  }
})

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
  drawControl.cardThrowsFor = null
  drawControl.chartThrows = false
  drawControl.presentThrows = false
  drawControl.captureThrows = false
  drawControl.questionsThrow = false
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
    // A button that fired and did nothing says so (KV-98 review).
    expect(screen.getByText('The history could be read after all, so nothing was moved.'))
      .toBeTruthy()
  })

  it('keeps the way out on screen when a press fails, so a held file can be tried again', async () => {
    // Before the review this took the button away: the press's own error was
    // untagged, so the box stopped being "unreadable" and became a dead end.
    listSessions.mockRejectedValue(unreadable())
    startNewHistory
      .mockRejectedValueOnce(fromMain(new Error('EBUSY'), 'sessions:startNewHistory'))
      .mockResolvedValueOnce(`${PATH}.unreadable-2026-09-24`)
    render(<App />)

    fireEvent.click(await screen.findByText('Start a new history'))
    expect(await screen.findByText(/could not be set aside just now, so nothing was moved/))
      .toBeTruthy()

    listSessions.mockResolvedValue([])
    fireEvent.click(screen.getByText('Start a new history'))
    expect(await screen.findByText(/kept, unchanged, as .*unreadable-2026-09-24/)).toBeTruthy()
  })

  it('offers no button when the press finds the file is from a newer version', async () => {
    listSessions.mockRejectedValue(unreadable())
    startNewHistory.mockRejectedValue(
      fromMain(new NewerStoreError(PATH, 2), 'sessions:startNewHistory'),
    )
    render(<App />)

    fireEvent.click(await screen.findByText('Start a new history'))

    expect(await screen.findByText(/written by a newer version of Kinvue/)).toBeTruthy()
    expect(screen.queryByText('Start a new history')).toBeNull()
  })

  it('still names where the old file went when the reload after it fails', async () => {
    listSessions
      .mockRejectedValueOnce(unreadable())
      .mockRejectedValueOnce(fromMain(new Error('odd'), 'sessions:list'))
    startNewHistory.mockResolvedValue(`${PATH}.unreadable-2026-09-24`)
    render(<App />)

    fireEvent.click(await screen.findByText('Start a new history'))

    expect(
      await screen.findByText(/old file was kept, unchanged, as .*unreadable-2026-09-24\. The list/),
    ).toBeTruthy()
  })

  it('cannot be pressed twice while the first press is still running', async () => {
    listSessions.mockRejectedValueOnce(unreadable()).mockResolvedValue([])
    let finish: (value: string) => void = () => undefined
    startNewHistory.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)))
    render(<App />)

    const button = await screen.findByText('Start a new history')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(startNewHistory).toHaveBeenCalledTimes(1)
    expect((button as HTMLButtonElement).disabled).toBe(true)

    finish(`${PATH}.unreadable-2026-09-24`)
    await screen.findByText(/new, empty history was started/)
  })

  it('clears the notice once the list is loaded again later', async () => {
    listSessions.mockRejectedValueOnce(unreadable()).mockResolvedValue([])
    startNewHistory.mockResolvedValue(`${PATH}.unreadable-2026-09-24`)
    seedDemo.mockResolvedValue(12)
    render(<App />)

    fireEvent.click(await screen.findByText('Start a new history'))
    await screen.findByText(/new, empty history was started/)

    listSessions.mockResolvedValue([session({ id: 'seeded' })])
    fireEvent.click(screen.getByText('Seed demo history'))
    await screen.findByText(/Looks normal|Not enough to say/)
    expect(screen.queryByText(/new, empty history was started/)).toBeNull()
  })
})

describe('a card whose pulse was never compared (KV-87)', () => {
  it('reads "Not enough to say" and names the metric, not "Looks normal"', async () => {
    const past = [
      ...history(2, { pulseRateBpm: 82 }),
      session({ id: 'h-2', capturedAt: '2026-09-03T09:00:00.000Z', vitals: { pulseRateBpm: null } }),
    ]
    const scored = session({ id: 'thin', vitals: { pulseRateBpm: 101.5 } })
    scored.assessment = scoreSession(scored, past)
    listSessions.mockResolvedValue([scored])
    render(<App />)

    expect(await screen.findByText('Not enough to say')).toBeTruthy()
    expect(screen.getByText(/^Pulse was measured at this check-in but not compared/)).toBeTruthy()
    expect(screen.queryByText('Looks normal')).toBeNull()
  })

  it('keeps an amber card amber, and names the gap under it without the withheld clause', async () => {
    const past = [
      ...history(2, { pulseRateBpm: 82 }),
      session({ id: 'h-2', capturedAt: '2026-09-03T09:00:00.000Z', vitals: { pulseRateBpm: null } }),
    ]
    const scored = session({
      id: 'amber',
      vitals: { pulseRateBpm: 101.5 },
      answers: { sleep: 'poorly', painReported: true, skippedMeal: true },
    })
    scored.assessment = scoreSession(scored, past)
    listSessions.mockResolvedValue([scored])
    render(<App />)

    expect(await screen.findByText('Looks different')).toBeTruthy()
    const note = screen.getByText(/^Pulse was measured at this check-in but not compared/)
    expect(note.textContent).toMatch(/\(those 2 averaged 82 bpm\)\.$/)
    expect(note.textContent).not.toMatch(/not being called normal/)
  })
})

describe('what they said, on every card (KV-110)', () => {
  it('shows an answer whether or not a rule fired on it', async () => {
    // Sleeping well fires nothing; sleeping badly fires `poor-sleep`. Before
    // KV-110 only the second was visible, so a card with no sleep line was
    // ambiguous between well, all right and unknown.
    const past = history(5)
    const fine = session({ id: 'fine', capturedAt: '2026-09-20T09:00:00.000Z' })
    fine.assessment = scoreSession(fine, past)
    const poorly = session({
      id: 'poorly',
      capturedAt: '2026-09-21T09:00:00.000Z',
      answers: { sleep: 'poorly' },
    })
    poorly.assessment = scoreSession(poorly, past)
    listSessions.mockResolvedValue([fine, poorly])
    render(<App />)

    // The whole row, not one phrase (KV-110 review): a row rendering only the
    // answer no rule covers, or a blank, must not pass.
    expect(
      await screen.findByText('Answers: mood good · sleep well · skipped meals no · pain no'),
    ).toBeTruthy()
    expect(screen.getByText('Answers: mood good · sleep badly · skipped meals no · pain no')).toBeTruthy()
    // The rule still says what counted, separately from what was answered.
    expect(screen.getByText('Slept poorly')).toBeTruthy()
  })
})

describe('an old card, shown with today’s words (KV-138)', () => {
  it('drops "today", keeps the verdict, and says what today’s scorer would add', async () => {
    const past = [14, 16, 14, 16, 15].map((b, i) =>
      session({
        id: `b-${i}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, 9)).toISOString(),
        vitals: { breathingRateBrpm: b },
      }),
    )
    for (const p of past) p.assessment = scoreSession(p, past.slice(0, past.indexOf(p)))
    const old = session({
      id: 'old',
      capturedAt: new Date(Date.UTC(2026, 8, 10, 9)).toISOString(),
      vitals: { breathingRateBrpm: 5 },
    })
    // As a scorer before KV-9 and KV-93 stored it.
    old.assessment = {
      flag: 'normal',
      firedRules: [],
      summary: 'Today looks like a normal day for them.',
      baselineSessions: 5,
      baselineSeededSessions: 0,
    }
    listSessions.mockResolvedValue([...past, old])
    render(<App />)

    expect(await screen.findByText(
      'Scored again now, it would also note breathing below usual.',
    )).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Today looks/)
    expect(screen.getAllByText('Looks normal').length).toBeGreaterThan(0)
  })
})

describe('where the baseline is, while it is learning (KV-17)', () => {
  const mine = (records: SessionRecord[]): SessionRecord[] =>
    records.map((r) => ({ ...r, personId: DEMO_PERSON_ID }))

  it('shows one live line and a "Still learning" label, apart from an unusable card', async () => {
    const good = mine(history(1))
    const refused = mine([
      session({ id: 'refused', capturedAt: '2026-08-01T09:00:00.000Z', vitals: { confidence: 0.2 } }),
    ])
    for (const r of [...refused, ...good]) {
      const prior = [...refused, ...good].filter((p) => p.capturedAt < r.capturedAt)
      r.assessment = scoreSession(r, prior)
    }
    listSessions.mockResolvedValue([...refused, ...good])
    render(<App />)

    expect(
      await screen.findByText(
        `Still learning ${DEMO_PERSON_NAME}’s usual — 1 of 3 usable check-ins so far. 1 check-in could not be used, so it is not counted.`,
      ),
    ).toBeTruthy()
    expect(screen.getByText('Too early to compare')).toBeTruthy()
    expect(screen.getByText('Not enough to say')).toBeTruthy()
  })

  it('says nothing once comparisons have started', async () => {
    // Scored as a real store holds them, so the first three cards are labelled
    // "Too early to compare" — which is right, and not what this is about: it
    // asserts the header's absence, not the page's (KV-17 review).
    const records = mine([...history(5), session({ id: 'now', capturedAt: '2026-10-01T09:00:00.000Z' })])
    records.forEach((r, i) => (r.assessment = scoreSession(r, records.slice(0, i))))
    listSessions.mockResolvedValue(records)
    render(<App />)

    expect((await screen.findAllByText('Too early to compare')).length).toBe(3)
    expect(screen.queryByText(/usable check-ins so far/)).toBeNull()
  })
})

describe('how far back a card’s usual reaches (KV-154)', () => {
  // The header line is live, measured to now; pin it. Only `Date` is faked, so
  // the async queries below still wait on real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T09:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  /** Five check-ins in January, then one on Sep 30: a usual gone stale. */
  const staleHistory = (extra: SessionRecord[] = []): SessionRecord[] => {
    const january = Array.from({ length: 5 }, (_, i) =>
      session({ id: `jan-${i}`, capturedAt: new Date(Date.UTC(2026, 0, i + 1, 9)).toISOString() }),
    )
    const now = session({ id: 'now', capturedAt: '2026-09-30T09:00:00.000Z' })
    const records = [...extra, ...january, now].map((r) => ({ ...r, personId: DEMO_PERSON_ID }))
    records.forEach((r, i) => {
      if (r.seeded !== true) r.assessment = scoreSession(r, records.slice(0, i))
    })
    return records
  }

  it('notes a stale usual on the card, and says once in the header how far back it reaches', async () => {
    listSessions.mockResolvedValue(staleHistory())
    render(<App />)

    expect(
      await screen.findByText(
        'Their usual here is 5 check-ins, the most recent of them 8 months before this one.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(`${DEMO_PERSON_NAME}’s usual is the last 6 usable check-ins reaching back 9 months.`),
    ).toBeTruthy()
    // Only the card whose usual had gone stale says so.
    expect(screen.getAllByText(/the most recent of them/).length).toBe(1)
  })

  it('puts the stale note after the seeded one, as the second half of it (review of #158)', async () => {
    const seeded = Array.from({ length: 3 }, (_, i) =>
      session({
        id: `seed-${i}`,
        capturedAt: new Date(Date.UTC(2025, 11, 20 + i, 9)).toISOString(),
        seeded: true,
      }),
    )
    listSessions.mockResolvedValue(staleHistory(seeded))
    render(<App />)

    const stale = await screen.findByText(
      'Their usual here is 8 check-ins, the most recent of them 8 months before this one.',
    )
    const seededNote = screen.getByText(/^Their usual here is partly seeded demo data — 3 of the 8/)
    expect(seededNote.compareDocumentPosition(stale) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the trend, one metric over the baseline window (KV-4)', () => {
  /** This person's check-ins, each scored against the ones before it, as a store holds them. */
  const scored = (records: SessionRecord[]): SessionRecord[] => {
    const mine = records.map((r) => ({ ...r, personId: DEMO_PERSON_ID }))
    mine.forEach((r, i) => {
      if (r.seeded !== true) r.assessment = scoreSession(r, mine.slice(0, i))
    })
    return mine
  }
  const latest = (over: Parameters<typeof session>[0] = {}): SessionRecord =>
    session({ id: 'latest', capturedAt: '2026-10-01T09:00:00.000Z', ...over })
  const circles = (): SVGCircleElement[] =>
    Array.from(document.querySelectorAll<SVGCircleElement>('section svg[role="img"] circle'))

  it('draws the metric chosen, with the latest marked and the usual the card compared with', async () => {
    listSessions.mockResolvedValue(scored([...history(5), latest({ vitals: { pulseRateBpm: 80 } })]))
    render(<App />)

    expect(await screen.findByText('Pulse, bpm, over the last 6 check-ins.')).toBeTruthy()
    expect(screen.getByText('their usual 72 bpm')).toBeTruthy()
    // The latest point's own label, in the drawing — the card beside it says 80 bpm too.
    expect(screen.getAllByText('80 bpm').some((e) => e.tagName.toLowerCase() === 'text')).toBe(true)
    expect(circles().filter((c) => c.dataset.latest === 'true').length).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Breathing' }))
    expect(screen.getByText('Breathing, br/min, over the last 6 check-ins.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Breathing' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('draws the not-flagged band behind the points, keyed, once there is a usual (KV-165)', async () => {
    listSessions.mockResolvedValue(scored([...history(5), latest({ vitals: { pulseRateBpm: 80 } })]))
    render(<App />)

    expect(await screen.findByText(/^pulse not flagged between \d+ and \d+ bpm$/)).toBeTruthy()
    expect(document.querySelectorAll('section svg[role="img"] rect[data-usual-range]').length).toBe(1)
    const label = document.querySelector('section svg[role="img"]')?.getAttribute('aria-label') ?? ''
    expect(label).toMatch(/Band: pulse not flagged between \d+ and \d+ bpm\./)
  })

  it('draws the band the right way up, edged, and HRV’s to the top of the plot (review of #168)', async () => {
    listSessions.mockResolvedValue(scored([...history(5), latest({ vitals: { pulseRateBpm: 80 } })]))
    render(<App />)
    await screen.findByText(/^pulse not flagged between/)
    const geometry = (): { top: number; bottom: number; edges: number[] } => {
      const rect = document.querySelector('section svg[role="img"] rect[data-usual-range]')!
      const top = Number(rect.getAttribute('y'))
      const height = Number(rect.getAttribute('height'))
      // A swapped low and high draws a negative or zero height.
      expect(height).toBeGreaterThan(0)
      const edges = Array.from(document.querySelectorAll('section svg[role="img"] line[data-band-edge]'))
        .map((l) => Number(l.getAttribute('y1')))
        .sort((a, b) => a - b)
      return { top, bottom: top + height, edges }
    }
    const pulse = geometry()
    expect(pulse.edges).toEqual([pulse.top, pulse.bottom])

    fireEvent.click(screen.getByRole('button', { name: 'HRV' }))
    await screen.findByText(/^HRV not flagged at \d+ ms or above$/)
    const hrv = geometry()
    expect(hrv.top).toBe(16) // the plot's top: HRV's band has no ceiling
    expect(hrv.edges).toEqual([hrv.bottom])
  })

  it('draws no range while the usual is still being learned (KV-165)', async () => {
    listSessions.mockResolvedValue(scored([...history(1), latest()]))
    render(<App />)
    await screen.findByText(/^No usual for pulse yet/)
    expect(document.querySelector('rect[data-usual-range]')).toBeNull()
    expect(screen.queryByText(/not flagged/)).toBeNull()
  })

  it('says on the chart when there is no usual yet, and draws no line (#17)', async () => {
    listSessions.mockResolvedValue(scored([...history(1), latest()]))
    render(<App />)

    expect(
      await screen.findByText(
        'No usual for pulse yet — 1 of the 3 readings needed, so there is no line to compare with.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/^their usual/)).toBeNull()
  })

  it('draws seeded days hollow, with a key, and says how many', async () => {
    const seeded = Array.from({ length: 4 }, (_, i) =>
      session({ id: `seed-${i}`, capturedAt: `2026-08-0${i + 1}T09:00:00.000Z`, seeded: true }),
    )
    listSessions.mockResolvedValue(scored([...seeded, ...history(2), latest()]))
    render(<App />)

    expect(
      await screen.findByText('4 of these points are seeded demo data, not measured.'),
    ).toBeTruthy()
    const hollow = circles().filter((c) => c.dataset.seeded === 'true')
    expect(hollow.length).toBe(4)
    for (const c of hollow) expect(c.getAttribute('fill')).toBe('var(--color-raised)')
    expect(screen.getByText('seeded demo data', { selector: 'span' })).toBeTruthy()
  })

  it('reads out the check-in nearest the pointer', async () => {
    listSessions.mockResolvedValue(scored([...history(5), latest({ vitals: { pulseRateBpm: 80 } })]))
    render(<App />)
    await screen.findByText('Pulse, bpm, over the last 6 check-ins.')

    // jsdom lays nothing out; give the chart the size of its own drawing.
    const svg = document.querySelector<SVGSVGElement>('section svg[role="img"]')
    vi.spyOn(svg!, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 180, right: 640, bottom: 180, x: 0, y: 0, toJSON: () => ({}),
    })
    fireEvent.pointerMove(svg!.querySelector('rect[data-pointer-area]')!, { clientX: 630 })
    const readout = screen.getByRole('tooltip')
    expect(readout.getAttribute('aria-live')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(readout.textContent).toContain('80 bpm')
    expect(readout.textContent).toContain('latest')
  })

  it('drops the readout when the metric changes under a parked pointer (second review of #162)', async () => {
    listSessions.mockResolvedValue(scored([...history(5), latest({ vitals: { pulseRateBpm: 80 } })]))
    render(<App />)
    await screen.findByText('Pulse, bpm, over the last 6 check-ins.')
    const svg = document.querySelector<SVGSVGElement>('section svg[role="img"]')
    vi.spyOn(svg!, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 640, height: 180, right: 640, bottom: 180, x: 0, y: 0, toJSON: () => ({}),
    })
    fireEvent.pointerMove(svg!.querySelector('rect[data-pointer-area]')!, { clientX: 630 })
    expect(screen.getByRole('tooltip')).toBeTruthy()

    // As from the keyboard: the pointer never leaves the plot.
    fireEvent.click(screen.getByRole('button', { name: 'HRV' }))
    expect(screen.getByText('HRV, ms, over the last 6 check-ins.')).toBeTruthy()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('dates a lone point under the point (second review of #162)', async () => {
    listSessions.mockResolvedValue(scored([latest()]))
    render(<App />)
    await screen.findByText('Pulse, bpm, at the latest check-in.')
    const dot = document.querySelector<SVGCircleElement>('section svg[role="img"] circle')
    const dates = document.querySelectorAll<SVGTextElement>('section svg [data-axis-date]')
    expect(dates.length).toBe(1)
    expect(dates[0]?.getAttribute('x')).toBe(dot?.getAttribute('cx'))
    expect(dates[0]?.getAttribute('text-anchor')).toBe('middle')
  })

  it('offers the same points as a table', async () => {
    listSessions.mockResolvedValue(scored([...history(2), latest({ vitals: { pulseRateBpm: 80 } })]))
    render(<App />)
    await screen.findByText('Show as a table')
    const rows = document.querySelectorAll('section table tbody tr')
    expect(rows.length).toBe(3)
    expect(rows[0]?.textContent).toContain('80')
    expect(rows[0]?.textContent).toContain('latest')
  })

  it('keeps the dashboard on screen over a record whose zone would throw (review of #162)', async () => {
    // The store casts parsed JSON without checking inside records; '' and an
    // unknown zone both make Intl throw, and there is no error boundary.
    const odd = scored([
      ...history(3),
      session({ id: 'blank-zone', capturedAt: '2026-09-20T09:00:00.000Z', timeZone: '' }),
      latest({ timeZone: 'Mars/Olympus_Mons' }),
    ])
    listSessions.mockResolvedValue(odd)
    render(<App />)
    expect(await screen.findByText('Pulse, bpm, over the last 5 check-ins.')).toBeTruthy()
    expect(screen.getAllByText(/^Looks normal$/).length).toBeGreaterThan(0)
  })

  it('quotes a fractional reading as the card does, whole (review of #162)', async () => {
    // Real captures are fractional; every other fixture here is whole, which
    // is where one decimal and none agree.
    listSessions.mockResolvedValue(scored([...history(3), latest({ vitals: { pulseRateBpm: 74.6 } })]))
    render(<App />)
    await screen.findByText('Show as a table')
    expect(screen.getAllByText('75 bpm').length).toBeGreaterThanOrEqual(2) // card and chart label
    expect(document.body.textContent).not.toMatch(/74\.6/)
  })

  it('keys only the kinds of point on the chart: an all-seeded demo has no "measured" (review of #162)', async () => {
    const demo = Array.from({ length: 5 }, (_, i) =>
      session({ id: `seed-${i}`, capturedAt: `2026-09-0${i + 1}T09:00:00.000Z`, seeded: true }),
    )
    listSessions.mockResolvedValue(scored(demo))
    render(<App />)
    expect(await screen.findByText('Every point here is seeded demo data, not measured.')).toBeTruthy()
    expect(screen.getByText('seeded demo data', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByText('measured', { selector: 'span' })).toBeNull()
  })

  it('dates points with the year when they cross into another (review of #162)', async () => {
    const december = Array.from({ length: 3 }, (_, i) =>
      session({ id: `dec-${i}`, capturedAt: `2025-12-2${i + 1}T12:00:00.000Z`, timeZone: 'UTC' }),
    )
    listSessions.mockResolvedValue(
      scored([...december, latest({ capturedAt: '2026-01-05T12:00:00.000Z', timeZone: 'UTC' })]),
    )
    render(<App />)
    await screen.findByText('Show as a table')
    const rows = Array.from(document.querySelectorAll('section table tbody tr')).map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('2026')
    expect(rows.at(-1)).toContain('2025')
  })

  it("decides the year in each point's own zone, not UTC (second review of #162)", async () => {
    // Both are Jan 2026 in Tokyo; the first is still 2025 in UTC.
    const tokyo = (id: string, capturedAt: string): SessionRecord =>
      session({ id, capturedAt, timeZone: 'Asia/Tokyo' })
    listSessions.mockResolvedValue(
      scored([
        tokyo('ny-1', '2025-12-31T20:00:00.000Z'),
        tokyo('ny-2', '2026-01-01T02:00:00.000Z'),
        tokyo('ny-3', '2026-01-02T02:00:00.000Z'),
        latest({ capturedAt: '2026-01-05T02:00:00.000Z', timeZone: 'Asia/Tokyo' }),
      ]),
    )
    render(<App />)
    await screen.findByText('Show as a table')
    const rows = Array.from(document.querySelectorAll('section table tbody tr')).map((r) => r.textContent ?? '')
    expect(rows.at(-1)).toContain('Jan 1')
    for (const row of rows) expect(row).not.toMatch(/202[56]/)
  })

  it('leaves the year off within one', async () => {
    listSessions.mockResolvedValue(scored([...history(2), latest()]))
    render(<App />)
    await screen.findByText('Show as a table')
    const first = document.querySelector('section table tbody tr')?.textContent ?? ''
    expect(first).not.toContain('2026')
  })

  it('keeps the notes on a tab with no readings to draw (second review of #162)', async () => {
    const noHrv = history(4, { hrvRmssdMs: null })
    listSessions.mockResolvedValue(
      scored([
        ...noHrv,
        latest({ vitals: { hrvRmssdMs: null } }),
        session({ id: 'r-1', capturedAt: '2026-10-02T09:00:00.000Z', vitals: { confidence: 0.2 } }),
        session({ id: 'r-2', capturedAt: '2026-10-03T09:00:00.000Z', vitals: { confidence: 0.2 } }),
      ]),
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'HRV' }))

    expect(screen.getByText('No HRV readings to draw.')).toBeTruthy()
    // No point is drawn, so none is called the earlier one.
    expect(screen.getByText('The 2 most recent check-ins could not be used.')).toBeTruthy()
    expect(screen.getByText('HRV was not measured at the latest check-in.')).toBeTruthy()
  })

  it('draws nothing when no check-in could be used', async () => {
    listSessions.mockResolvedValue(
      scored([session({ id: 'r', capturedAt: '2026-09-01T09:00:00.000Z', vitals: { confidence: 0.2 } })]),
    )
    render(<App />)
    await screen.findByText('Not enough to say')
    expect(screen.queryByRole('button', { name: 'Pulse' })).toBeNull()
  })
})

describe('one section that cannot be drawn (KV-163)', () => {
  const three = (): SessionRecord[] =>
    [
      ...history(3),
      session({ id: 'latest', capturedAt: '2026-10-01T09:00:00.000Z', vitals: { pulseRateBpm: 80 } }),
    ].map((r) => ({ ...r, personId: DEMO_PERSON_ID }))
  const cards = (): Element[] => Array.from(document.querySelectorAll('article'))

  it('leaves a sentence where that card was, and the other cards and the chart drawn', async () => {
    drawControl.cardThrowsFor = 'h-1'
    listSessions.mockResolvedValue(three())
    render(<App />)

    expect(
      await screen.findByText('This check-in could not be shown. It is still saved, unchanged.'),
    ).toBeTruthy()
    expect(cards().length).toBe(3)
    expect(screen.getByText('Pulse, bpm, over the last 4 check-ins.')).toBeTruthy()
    // For the developer, in the console; never on the screen.
    expect(console.error).toHaveBeenCalledWith(
      'A dashboard section could not be drawn.',
      expect.objectContaining({ message: 'card failed to draw' }),
      expect.anything(),
    )
    expect(document.body.textContent).not.toMatch(/failed to draw|Error/)
  })

  it('keeps every card when the chart is the part that fails', async () => {
    drawControl.chartThrows = true
    listSessions.mockResolvedValue(three())
    render(<App />)

    expect(await screen.findByText(/^The trend could not be drawn\./)).toBeTruthy()
    expect(cards().length).toBe(4)
    expect(screen.queryByRole('button', { name: 'Pulse' })).toBeNull()
  })

  it("says so in a sentence when the screen's own code throws, and offers another try", async () => {
    drawControl.presentThrows = true
    listSessions.mockResolvedValue(three())
    render(<App />)

    const sentence = await screen.findByText(
      'Kinvue could not show this screen. Nothing saved has been changed.',
    )
    // Still the page's landmark, so it can be found (review of #164).
    expect(screen.getByRole('main').contains(sentence)).toBe(true)
    expect(console.error).toHaveBeenCalledWith(
      'A dashboard section could not be drawn.',
      expect.objectContaining({ message: 'scoring failed while drawing' }),
      expect.anything(),
    )
    expect(document.body.textContent).not.toMatch(/failed while drawing|Error/)
    // Whatever it caught, a capture may be running: it is abandoned.
    expect(window.kinvue.cancelCapture).toHaveBeenCalled()

    // A throw that has cleared: "Try again" draws the screen from nothing.
    drawControl.presentThrows = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Pulse, bpm, over the last 4 check-ins.')).toBeTruthy()
    expect(cards().length).toBe(4)
  })

  it("fails one card, not the screen, for a record that cannot be presented (review of #164)", async () => {
    // A real one, not a mock: a stored assessment the store let through without
    // its fired rules, which `present` cannot read.
    const records = three()
    const damaged = records[1]!
    damaged.assessment = { flag: 'normal', summary: 'x' } as unknown as SessionRecord['assessment']
    listSessions.mockResolvedValue(records)
    render(<App />)

    expect(
      await screen.findByText('This check-in could not be shown. It is still saved, unchanged.'),
    ).toBeTruthy()
    expect(cards().length).toBe(3)
    expect(screen.queryByText(/^Kinvue could not show this screen/)).toBeNull()
    expect(console.error).toHaveBeenCalledWith(
      `Check-in ${damaged.id} could not be presented.`,
      expect.any(TypeError),
    )
  })

  describe('while a reading or the questions are on screen (review of #164)', () => {
    const vitals = session().vitals
    const startReading = async (capture: () => Promise<unknown>): Promise<void> => {
      Object.assign(window.kinvue, { capture: vi.fn(capture) })
      listSessions.mockResolvedValue(three())
      render(<App />)
      fireEvent.click(await screen.findByRole('button', { name: 'Take a reading' }))
    }

    it('stops the camera when the capture screen cannot be drawn', async () => {
      drawControl.captureThrows = true
      // A capture that would run to its ceiling if nothing stopped it.
      await startReading(() => new Promise(() => undefined))

      expect(
        await screen.findByText(/^The camera screen could not be shown, so the camera was stopped/),
      ).toBeTruthy()
      expect(window.kinvue.cancelCapture).toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Take a reading' })).toBeTruthy()
      expect(screen.queryByText(/^Kinvue could not show this screen/)).toBeNull()
    })

    it('keeps the reading when the questions cannot be drawn', async () => {
      drawControl.questionsThrow = true
      await startReading(() => Promise.resolve({ captureId: 'c-1', vitals }))

      expect(
        await screen.findByText(/^The questions could not be shown\. The reading is kept below/),
      ).toBeTruthy()
      // Back on the dashboard, with the reading still offered for answering.
      expect(screen.getByRole('button', { name: 'Answer the questions anyway' })).toBeTruthy()
      expect(screen.queryByText(/^Kinvue could not show this screen/)).toBeNull()
    })
  })

  it('tries a failed section again when what it is drawn from changes', () => {
    const Draw = ({ ok }: { ok: boolean }): React.JSX.Element => {
      if (!ok) throw new Error('bad data')
      return <p>drawn</p>
    }
    const at = (key: number, ok: boolean): React.JSX.Element => (
      <SectionBoundary fallback="could not be shown" className="" resetKey={key}>
        <Draw ok={ok} />
      </SectionBoundary>
    )
    const { rerender } = render(at(1, false))
    expect(screen.getByText('could not be shown')).toBeTruthy()
    // The same data again: not retried, even though it would draw now.
    rerender(at(1, true))
    expect(screen.getByText('could not be shown')).toBeTruthy()
    // New data: tried again.
    rerender(at(2, true))
    expect(screen.getByText('drawn')).toBeTruthy()
  })

  it('does not retry data that arrived with its new key and threw (review of #164)', () => {
    // The common case: a reload brings the new key and the record that breaks
    // the section in one commit. Comparing against the previous props saw a
    // key change, reset, and drew the same data a second time.
    const Draw = ({ ok }: { ok: boolean }): React.JSX.Element => {
      if (!ok) throw new Error('bad data')
      return <p>drawn</p>
    }
    const at = (key: number, ok: boolean): React.JSX.Element => (
      <SectionBoundary fallback="could not be shown" className="" resetKey={key}>
        <Draw ok={ok} />
      </SectionBoundary>
    )
    const { rerender } = render(at(1, true))
    rerender(at(2, false))
    expect(screen.getByText('could not be shown')).toBeTruthy()
    const logged = vi
      .mocked(console.error)
      .mock.calls.filter(([first]) => first === 'A dashboard section could not be drawn.')
    expect(logged.length).toBe(1)
  })
})
