import { describe, expect, it } from 'vitest'
import { scoreSession } from '@core/scoring'
import { createCheckIn, PENDING_CAPTURE_TTL_MS, type CheckInDeps } from '@core/session/checkin'
import type { CheckInAnswers, SessionRecord, Vitals } from '@core/session/types'
import { session } from './helpers'

const PERSON = 'test-person'
const ANSWERS: CheckInAnswers = session().answers
const READING: Vitals = session().vitals
const START = new Date('2026-09-15T09:00:00.000Z')

/** A check-in over an in-memory store, with a clock and ids the test controls. */
function setup(overrides: Partial<CheckInDeps> = {}) {
  const stored: SessionRecord[] = []
  let clock = START.getTime()
  let next = 0
  const deps: CheckInDeps = {
    store: {
      list: async (personId) => stored.filter((s) => s.personId === personId),
      append: async (record) => {
        stored.push(record)
      },
    },
    score: scoreSession,
    now: () => new Date(clock),
    newId: () => `id-${next++}`,
    ...overrides,
  }
  return {
    checkIn: createCheckIn(deps),
    stored,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const measure = (vitals: Vitals = READING) => async (): Promise<Vitals> => vitals
const failing = async (): Promise<Vitals> => {
  throw new Error('camera busy')
}

describe('createCheckIn', () => {
  it('stores the vitals main measured, under the person they were taken for', async () => {
    const { checkIn, stored } = setup()
    const { captureId } = await checkIn.capture(PERSON, measure())
    const record = await checkIn.submit(PERSON, captureId, ANSWERS)

    expect(stored).toEqual([record])
    expect(record.vitals).toEqual(READING)
    expect(record.personId).toBe(PERSON)
    expect(record.capturedAt).toBe(START.toISOString())
    expect(record.assessment).toBeDefined()
  })

  it('stores a double submit once', async () => {
    const { checkIn, stored } = setup()
    const { captureId } = await checkIn.capture(PERSON, measure())
    const results = await Promise.allSettled([
      checkIn.submit(PERSON, captureId, ANSWERS),
      checkIn.submit(PERSON, captureId, ANSWERS),
    ])

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(stored).toHaveLength(1)
  })

  it('rejects a capture that a newer one replaced', async () => {
    const { checkIn, stored } = setup()
    const first = await checkIn.capture(PERSON, measure())
    const second = await checkIn.capture(PERSON, measure())

    await expect(checkIn.submit(PERSON, first.captureId, ANSWERS)).rejects.toThrow('newer')
    await checkIn.submit(PERSON, second.captureId, ANSWERS)
    expect(stored).toHaveLength(1)
  })

  it('rejects a second capture while one is running', async () => {
    const { checkIn } = setup()
    let finish: (v: Vitals) => void = () => undefined
    const running = checkIn.capture(PERSON, () => new Promise<Vitals>((r) => (finish = r)))

    await expect(checkIn.capture(PERSON, measure())).rejects.toThrow('already running')
    finish(READING)
    await running
  })

  it('keeps the earlier reading when a retake fails', async () => {
    const { checkIn, stored } = setup()
    const { captureId } = await checkIn.capture(PERSON, measure())

    await expect(checkIn.capture(PERSON, failing)).rejects.toThrow('camera busy')
    await checkIn.submit(PERSON, captureId, ANSWERS)
    expect(stored).toHaveLength(1)
  })

  it('rejects a submit for a different person, and does not refile the reading', async () => {
    const { checkIn, stored } = setup()
    const { captureId } = await checkIn.capture(PERSON, measure())

    await expect(checkIn.submit('someone-else', captureId, ANSWERS)).rejects.toThrow(
      'different person',
    )
    expect(stored).toEqual([])
    // The mismatch was a caller bug; the reading still belongs to its person.
    await checkIn.submit(PERSON, captureId, ANSWERS)
    expect(stored.map((s) => s.personId)).toEqual([PERSON])
  })

  it('rejects a reading older than the TTL, and will not take it afterwards either', async () => {
    const { checkIn, stored, advance } = setup()
    const { captureId } = await checkIn.capture(PERSON, measure())
    advance(PENDING_CAPTURE_TTL_MS + 1)

    await expect(checkIn.submit(PERSON, captureId, ANSWERS)).rejects.toThrow('too old')
    await expect(checkIn.submit(PERSON, captureId, ANSWERS)).rejects.toThrow()
    expect(stored).toEqual([])
  })

  it('accepts a reading exactly at the TTL', async () => {
    const { checkIn, stored, advance } = setup()
    const { captureId } = await checkIn.capture(PERSON, measure())
    advance(PENDING_CAPTURE_TTL_MS)

    await checkIn.submit(PERSON, captureId, ANSWERS)
    expect(stored).toHaveLength(1)
  })

  it('keeps the reading submittable when storing it fails', async () => {
    let failNext = true
    const stored: SessionRecord[] = []
    const { checkIn } = setup({
      store: {
        list: async () => [],
        append: async (record) => {
          if (failNext) {
            failNext = false
            throw new Error('disk full')
          }
          stored.push(record)
        },
      },
    })
    const { captureId } = await checkIn.capture(PERSON, measure())

    await expect(checkIn.submit(PERSON, captureId, ANSWERS)).rejects.toThrow('disk full')
    await checkIn.submit(PERSON, captureId, ANSWERS)
    expect(stored).toHaveLength(1)
  })

  it('does not bring back a failed submit once a newer capture has succeeded', async () => {
    // The newer capture is also submitted before the older save fails, so
    // nothing is pending when the failure lands — restoring whenever nothing is
    // pending would make the replaced reading submittable again.
    let failAppend: () => void = () => undefined
    let appends = 0
    const { checkIn } = setup({
      store: {
        list: async () => [],
        append: () => {
          appends++
          if (appends > 1) return Promise.resolve()
          return new Promise<void>((_resolve, reject) => {
            failAppend = () => reject(new Error('disk full'))
          })
        },
      },
    })
    const first = await checkIn.capture(PERSON, measure())
    const submitting = checkIn.submit(PERSON, first.captureId, ANSWERS)
    // Let the submit reach append before the newer capture lands.
    await new Promise((r) => setTimeout(r, 0))
    const second = await checkIn.capture(PERSON, measure())
    await checkIn.submit(PERSON, second.captureId, ANSWERS)
    failAppend()

    await expect(submitting).rejects.toThrow('disk full')
    await expect(checkIn.submit(PERSON, first.captureId, ANSWERS)).rejects.toThrow('newer')
  })

  it('brings a failed submit back when the retake during it also failed', async () => {
    let failAppend: () => void = () => undefined
    let appends = 0
    const { checkIn } = setup({
      store: {
        list: async () => [],
        append: () => {
          appends++
          if (appends > 1) return Promise.resolve()
          return new Promise<void>((_resolve, reject) => {
            failAppend = () => reject(new Error('disk full'))
          })
        },
      },
    })
    const first = await checkIn.capture(PERSON, measure())
    const submitting = checkIn.submit(PERSON, first.captureId, ANSWERS)
    await new Promise((r) => setTimeout(r, 0))
    await expect(checkIn.capture(PERSON, failing)).rejects.toThrow('camera busy')
    failAppend()

    await expect(submitting).rejects.toThrow('disk full')
    await expect(checkIn.submit(PERSON, first.captureId, ANSWERS)).resolves.toBeDefined()
  })

  it('rejects an id that was never captured', async () => {
    const { checkIn } = setup()
    await expect(checkIn.submit(PERSON, 'made-up', ANSWERS)).rejects.toThrow('latest capture')
  })
})
