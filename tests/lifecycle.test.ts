import { describe, expect, it } from 'vitest'
import {
  chosenFor,
  describeLastExport,
  describeRefusal,
  describeRestore,
  EXPORT_KIND,
  EXPORT_VERSION,
  exportOf,
  parseRemoval,
  planRestore,
  remove,
  type History,
  type RestoreOutcome,
} from '@core/session/lifecycle'
import type { SessionRecord } from '@core/session/types'
import { session } from './helpers'

/**
 * Exporting, restoring and deleting a history (KV-21), held to the policy in
 * ARCHITECTURE.md: tombstones that win over a copy coming back, verdicts that
 * stand, a restore that writes what it accepts or nothing, and says which.
 */

const PERSON = 'test-person'
const NOW = new Date('2026-10-05T12:00:00.000Z')
/** One of this person's check-ins, `day` days after 1 September. */
const on = (day: number, over: Parameters<typeof session>[0] = {}): SessionRecord =>
  session({
    id: `d-${String(day)}`,
    capturedAt: new Date(Date.UTC(2026, 8, 1, 9) + day * 86_400_000).toISOString(),
    ...over,
  })
const historyOf = (sessions: SessionRecord[]): History => ({ sessions, removed: [] })
const day = (instant: string): string => instant.slice(0, 10)

describe('parseRemoval: what a deletion request from the renderer may be', () => {
  it('takes the three kinds, rebuilt field by field', () => {
    expect(parseRemoval({ kind: 'all', extra: 1 })).toEqual({ kind: 'all' })
    expect(parseRemoval({ kind: 'one', id: 'd-1', extra: 1 })).toEqual({ kind: 'one', id: 'd-1' })
    expect(parseRemoval({ kind: 'before', before: '2026-09-03T00:00:00.000Z' })).toEqual({
      kind: 'before',
      before: '2026-09-03T00:00:00.000Z',
    })
  })

  it('refuses anything else, including a time that is not one instant', () => {
    for (const bad of [
      null,
      'all',
      { kind: 'some' },
      { kind: 'one' },
      { kind: 'one', id: '' },
      { kind: 'before', before: '2026-09-03' },
      { kind: 'before', before: 'yesterday' },
    ]) {
      expect(parseRemoval(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('remove: deleting check-ins, and what is kept of them (KV-21)', () => {
  const days = [on(0), on(1), on(2), on(3)]

  it('deletes one, every one before an instant, or all, and only this person’s', () => {
    const theirs = [...days, on(1.5, { id: 'other' })]
    theirs.at(-1)!.personId = 'another-person'
    const ids = (which: Parameters<typeof chosenFor>[2]): string[] =>
      chosenFor(theirs, PERSON, which).map((r) => r.id)
    expect(ids({ kind: 'one', id: 'd-2' })).toEqual(['d-2'])
    expect(ids({ kind: 'before', before: days[2]!.capturedAt })).toEqual(['d-0', 'd-1'])
    expect(ids({ kind: 'all' })).toEqual(['d-0', 'd-1', 'd-2', 'd-3'])
  })

  it('decides a record with no zone by the same instant as any other', () => {
    const zoneless = on(1)
    const zoned = on(2, { timeZone: 'Asia/Tokyo' })
    const before = new Date(Date.UTC(2026, 8, 4)).toISOString()
    const chosen = chosenFor([zoneless, zoned], PERSON, { kind: 'before', before })
    expect(chosen.map((r) => r.id)).toEqual(['d-1', 'd-2'])
  })

  it('removes the records and keeps a tombstone of each: id, whose, when — nothing else', () => {
    const which = { kind: 'before' as const, before: days[2]!.capturedAt }
    const { history, removed } = remove(historyOf(days), PERSON, which, NOW)
    expect(removed).toBe(2)
    expect(history.sessions.map((r) => r.id)).toEqual(['d-2', 'd-3'])
    expect(history.removed).toEqual([
      { id: 'd-0', personId: PERSON, removedAt: NOW.toISOString() },
      { id: 'd-1', personId: PERSON, removedAt: NOW.toISOString() },
    ])
  })

  it('keeps no tombstone for a seeded day, whose id repeats across installs', () => {
    const seeded = on(4, { id: 'seed-test-person-1', seeded: true })
    const { history, removed } = remove(historyOf([...days, seeded]), PERSON, { kind: 'all' }, NOW)
    expect(removed).toBe(5)
    expect(history.sessions).toEqual([])
    expect(history.removed.map((t) => t.id)).toEqual(['d-0', 'd-1', 'd-2', 'd-3'])
  })

  it('changes nothing when nothing is named', () => {
    const before = historyOf(days)
    expect(remove(before, PERSON, { kind: 'one', id: 'nope' }, NOW)).toEqual({
      history: before,
      removed: 0,
    })
  })
})

describe('exportOf: a person’s history as a restorable file (KV-21)', () => {
  it('holds their real records exactly as stored, and their tombstones, and no demo days', () => {
    const record = on(1, {
      timeZone: 'Europe/London',
      answers: { painReported: true, painNote: 'knee' },
    })
    const others = on(2, { id: 'other' })
    others.personId = 'another-person'
    const history: History = {
      sessions: [record, on(0, { id: 'seed-1', seeded: true }), others],
      removed: [
        { id: 'gone', personId: PERSON, removedAt: NOW.toISOString() },
        { id: 'theirs', personId: 'another-person', removedAt: NOW.toISOString() },
      ],
    }
    const file = exportOf(history, PERSON, NOW)
    expect(file).toEqual({
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: NOW.toISOString(),
      personId: PERSON,
      records: [record],
      removed: [{ id: 'gone', personId: PERSON, removedAt: NOW.toISOString() }],
    })
  })
})

describe('planRestore: everything it accepts, or nothing, and in this order (KV-21)', () => {
  const file = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...exportOf(historyOf([on(0), on(1), on(2)]), PERSON, NOW),
    ...over,
  })
  const refusal = (f: unknown, history: History = historyOf([])): unknown => {
    const plan = planRestore(history, PERSON, f)
    return plan.ok ? 'accepted' : plan.refusal
  }

  it('refuses what is not an export, and a newer one as newer', () => {
    expect(refusal({ sessions: [] })).toEqual({ kind: 'not-an-export' })
    expect(refusal('text')).toEqual({ kind: 'not-an-export' })
    expect(refusal(file({ version: EXPORT_VERSION + 1 }))).toEqual({ kind: 'newer' })
    expect(refusal(file({ version: '1' }))).toEqual({
      kind: 'unreadable',
      why: 'it does not say which version of an export it is',
    })
    expect(refusal(file({ records: {} }))).toEqual({
      kind: 'unreadable',
      why: 'it has no list of check-ins',
    })
  })

  it('refuses someone else’s history before reading a record of it', () => {
    expect(refusal(file({ personId: 'another-person' }))).toEqual({ kind: 'someone-else' })
  })

  it('refuses a record in a newer format as a whole file, before naming any broken entry', () => {
    const records = [{ ...on(0), vitals: null }, { ...on(1), format: 2 }]
    expect(refusal(file({ records }))).toEqual({ kind: 'newer' })
  })

  it('names the first entry it cannot read, and why', () => {
    const records = [on(0), { ...on(1), capturedAt: 'yesterday' }]
    expect(refusal(file({ records }))).toEqual({
      kind: 'entry',
      position: 2,
      total: 2,
      why: 'capturedAt is not a time',
    })
    expect(refusal(file({ records: [on(0, { seeded: true })] }))).toMatchObject({
      why: 'it is demo data, which is never exported',
    })
    const theirs = on(0)
    theirs.personId = 'another-person'
    expect(refusal(file({ records: [theirs] }))).toMatchObject({ why: 'it is someone else’s' })
    const badTombstone = { id: 'x', personId: PERSON, removedAt: 'today' }
    expect(refusal(file({ removed: [badTombstone] }))).toEqual({
      kind: 'entry',
      position: 4,
      total: 4,
      why: 'removedAt is not a time',
    })
  })

  it('refuses a different check-in under an id already held', () => {
    const here = historyOf([on(1, { vitals: { pulseRateBpm: 99 } })])
    expect(refusal(file(), here)).toEqual({
      kind: 'entry',
      position: 2,
      total: 3,
      why: 'it is a different check-in under an id this history already holds',
    })
  })

  it('restores into an empty history exactly what was exported', () => {
    const exported = exportOf(historyOf([on(0), on(1)]), PERSON, NOW)
    const plan = planRestore(historyOf([]), PERSON, JSON.parse(JSON.stringify(exported)))
    expect(plan.ok && plan.history.sessions).toEqual([on(0), on(1)])
    expect(plan.ok && plan.outcome).toMatchObject({ restored: 2, alreadyHere: 0, stayDeleted: 0 })
  })

  it('changes nothing the second time the same file is restored', () => {
    const first = planRestore(historyOf([]), PERSON, file())
    if (!first.ok) throw new Error('refused')
    const second = planRestore(first.history, PERSON, file())
    expect(second.ok && second.history).toEqual(first.history)
    expect(second.ok && second.outcome).toMatchObject({ restored: 0, alreadyHere: 3 })
  })

  it('export, delete everything, restore: nothing comes back, and it says why', () => {
    // The order the confirm screen offers (review of #184).
    const start = historyOf([on(0), on(1), on(2)])
    const exported = exportOf(start, PERSON, NOW)
    const on3October = new Date('2026-10-03T10:00:00.000Z')
    const deleted = remove(start, PERSON, { kind: 'all' }, on3October).history
    const plan = planRestore(deleted, PERSON, exported)
    expect(plan.ok && plan.history).toEqual(deleted)
    expect(plan.ok && plan.outcome).toEqual({
      restored: 0,
      alreadyHere: 0,
      stayDeleted: 3,
      deletedAt: Array(3).fill('2026-10-03T10:00:00.000Z'),
      removedByFile: 0,
    })
  })

  it('restores what was not deleted, and keeps deleted what was', () => {
    const start = historyOf([on(0), on(1), on(2)])
    const exported = exportOf(start, PERSON, NOW)
    const afterOne = remove(start, PERSON, { kind: 'one', id: 'd-1' }, NOW).history
    const emptied: History = { sessions: [], removed: afterOne.removed }
    const plan = planRestore(emptied, PERSON, exported)
    expect(plan.ok && plan.history.sessions.map((r) => r.id)).toEqual(['d-0', 'd-2'])
    expect(plan.ok && plan.outcome).toMatchObject({ restored: 2, stayDeleted: 1 })
  })

  it('lets a tombstone in the file remove the record it names here', () => {
    const there = remove(historyOf([on(0), on(1)]), PERSON, { kind: 'one', id: 'd-1' }, NOW).history
    const plan = planRestore(historyOf([on(0), on(1)]), PERSON, exportOf(there, PERSON, NOW))
    expect(plan.ok && plan.history.sessions.map((r) => r.id)).toEqual(['d-0'])
    expect(plan.ok && plan.history.removed.map((t) => t.id)).toEqual(['d-1'])
    expect(plan.ok && plan.outcome).toMatchObject({ alreadyHere: 1, removedByFile: 1 })
  })
})

describe('what the screens say (KV-21)', () => {
  const outcome = (over: Partial<RestoreOutcome>): RestoreOutcome => ({
    restored: 0,
    alreadyHere: 0,
    stayDeleted: 0,
    deletedAt: [],
    removedByFile: 0,
    ...over,
  })
  const deleted = (n: number): string[] => Array<string>(n).fill('2026-10-03T10:00:00.000Z')

  it('says what was restored and names what was skipped', () => {
    expect(describeRestore(outcome({ stayDeleted: 60, deletedAt: deleted(60) }), day)).toBe(
      'None restored: all 60 check-ins in this file were deleted on this device on 2026-10-03, ' +
        'and stay deleted.',
    )
    const mixed = outcome({ restored: 12, stayDeleted: 3, deletedAt: deleted(3) })
    expect(describeRestore(mixed, day)).toBe(
      'Restored 12 check-ins. 3 check-ins were deleted on this device on 2026-10-03, and ' +
        'stay deleted.',
    )
    expect(describeRestore(outcome({ restored: 1, alreadyHere: 48 }), day)).toBe(
      'Restored 1 check-in. 48 check-ins were already here.',
    )
    expect(describeRestore(outcome({ alreadyHere: 60 }), day)).toBe(
      'Nothing to restore: all 60 check-ins in this file are already here.',
    )
    expect(describeRestore(outcome({ alreadyHere: 1, removedByFile: 1 }), day)).toBe(
      'Nothing to restore: the check-in in this file is already here. 1 check-in here was ' +
        'deleted where this file was made, and is now deleted here too.',
    )
  })

  it('names no day when the skipped ones were deleted on more than one', () => {
    const mixed = ['2026-10-01T10:00:00.000Z', '2026-10-03T10:00:00.000Z']
    expect(describeRestore(outcome({ stayDeleted: 2, deletedAt: mixed }), day)).toBe(
      'None restored: all 2 check-ins in this file were deleted on this device, and stay deleted.',
    )
  })

  it('says why a file was refused, and that nothing changed', () => {
    expect(describeRefusal({ kind: 'newer' })).toBe(
      'That file was made by a newer version of Kinvue, which can restore it. ' +
        'Nothing has been changed.',
    )
    const why = 'capturedAt is not a time'
    const entry = { kind: 'entry' as const, position: 3, total: 60, why }
    expect(describeRefusal(entry)).toBe(
      'Entry 3 of 60 in that file cannot be restored: capturedAt is not a time. ' +
        'Nothing has been changed.',
    )
  })

  it('shows when the last export was made, and how much has happened since', () => {
    expect(describeLastExport(null, [on(0)], day)).toBe('Last exported: never.')
    const at = on(1).capturedAt
    const sessions = [on(0), on(1), on(2), on(3), on(4, { id: 'seed', seeded: true })]
    expect(describeLastExport(at, sessions, day)).toBe(
      'Last exported 2026-09-02 (2 check-ins since).',
    )
  })
})
