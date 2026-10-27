import { describe, expect, it } from 'vitest'
import { DEMO_PERSON_ID, type Person } from '@core/session/people'
import {
  chosenFor,
  describeAdded,
  describeLastExport,
  describeRefusal,
  describeRestore,
  EXPORT_BEFORE_KEYS,
  EXPORT_KIND,
  EXPORT_VERSION,
  exportOf,
  parseRemoval,
  planRestore,
  remove,
  whoseExport,
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
/** The person `PERSON` is: an export carries their key and name (KV-18). */
const ME: Person = {
  id: PERSON,
  key: '11111111-1111-4111-8111-111111111111',
  name: 'Ann',
  addedAt: '2026-09-01T09:00:00.000Z',
}
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
    // A seeded day is the demo's, whoever it was written under (KV-18): deleting
    // the person leaves it, and deleting the demo takes it, with no tombstone.
    const theirs = remove(historyOf([...days, seeded]), PERSON, { kind: 'all' }, NOW)
    expect(theirs.removed).toBe(4)
    expect(theirs.history.sessions.map((r) => r.id)).toEqual(['seed-test-person-1'])
    // Chosen as the demo's, kept as stored: the record itself is not rewritten.
    expect(theirs.history.sessions[0]?.personId).toBe(PERSON)

    const demo = remove(theirs.history, DEMO_PERSON_ID, { kind: 'all' }, NOW)
    expect(demo.removed).toBe(1)
    expect(demo.history.sessions).toEqual([])
    expect(demo.history.removed.map((t) => t.id)).toEqual(['d-0', 'd-1', 'd-2', 'd-3'])
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
    const file = exportOf(history, ME, NOW)
    expect(file).toEqual({
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: NOW.toISOString(),
      personId: PERSON,
      person: { key: ME.key, name: 'Ann' },
      records: [record],
      removed: [{ id: 'gone', personId: PERSON, removedAt: NOW.toISOString() }],
    })
  })
})

describe('planRestore: everything it accepts, or nothing, and in this order (KV-21)', () => {
  const file = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...exportOf(historyOf([on(0), on(1), on(2)]), ME, NOW),
    ...over,
  })
  const refusal = (f: unknown, history: History = historyOf([])): unknown => {
    const plan = planRestore(history, PERSON, f)
    return plan.ok ? 'accepted' : plan.refusal
  }

  it('refuses what is not an export, and a newer one as newer', () => {
    expect(refusal({ sessions: [] })).toEqual({ kind: 'not-an-export' })
    expect(refusal('text')).toEqual({ kind: 'not-an-export' })
    expect(refusal(file({ version: EXPORT_VERSION + 1 }))).toEqual({
      kind: 'newer',
      of: 'export',
      version: EXPORT_VERSION + 1,
    })
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
    expect(refusal(file({ records }))).toEqual({ kind: 'newer', of: 'record', version: 2 })
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
    const exported = exportOf(historyOf([on(0), on(1)]), ME, NOW)
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
    const exported = exportOf(start, ME, NOW)
    const on3October = new Date('2026-10-03T10:00:00.000Z')
    const deleted = remove(start, PERSON, { kind: 'all' }, on3October).history
    const plan = planRestore(deleted, PERSON, exported)
    expect(plan.ok && plan.history).toEqual(deleted)
    expect(plan.ok && plan.outcome).toEqual({
      restored: 0,
      alreadyHere: 0,
      stayDeleted: 3,
      deletedAt: Array(3).fill('2026-10-03T10:00:00.000Z'),
      deletedThere: 0,
    })
  })

  it('restores what was not deleted, and keeps deleted what was', () => {
    const start = historyOf([on(0), on(1), on(2)])
    const exported = exportOf(start, ME, NOW)
    const afterOne = remove(start, PERSON, { kind: 'one', id: 'd-1' }, NOW).history
    const emptied: History = { sessions: [], removed: afterOne.removed }
    const plan = planRestore(emptied, PERSON, exported)
    expect(plan.ok && plan.history.sessions.map((r) => r.id)).toEqual(['d-0', 'd-2'])
    expect(plan.ok && plan.outcome).toMatchObject({ restored: 2, stayDeleted: 1 })
  })

  it('never deletes: a tombstone in the file for a check-in held here is ignored', () => {
    // Device A deleted d-1 and exported; device B still holds d-1 (review of #185).
    const there = remove(historyOf([on(0), on(1)]), PERSON, { kind: 'one', id: 'd-1' }, NOW).history
    const plan = planRestore(historyOf([on(0), on(1)]), PERSON, exportOf(there, ME, NOW))
    expect(plan.ok && plan.history.sessions.map((r) => r.id)).toEqual(['d-0', 'd-1'])
    expect(plan.ok && plan.history.removed).toEqual([])
    expect(plan.ok && plan.outcome).toMatchObject({ alreadyHere: 1, restored: 0 })
  })

  it('keeps a file\u2019s tombstone for one not held here: an older export cannot bring it', () => {
    const start = historyOf([on(0), on(1)])
    const older = exportOf(start, ME, NOW)
    const pruned = remove(start, PERSON, { kind: 'one', id: 'd-1' }, NOW).history
    const newer = exportOf(pruned, ME, NOW)
    // A new device restores the newer export, then the older one.
    const first = planRestore(historyOf([]), PERSON, newer)
    if (!first.ok) throw new Error('refused')
    expect(first.history.removed.map((t) => t.id)).toEqual(['d-1'])
    const second = planRestore(first.history, PERSON, older)
    expect(second.ok && second.history.sessions.map((r) => r.id)).toEqual(['d-0'])
    expect(second.ok && second.outcome).toMatchObject({ alreadyHere: 1, stayDeleted: 1 })
  })

  it('does not restore a check-in the file itself says was deleted, and says where', () => {
    const file = exportOf(historyOf([on(0)]), ME, NOW)
    const inconsistent = {
      ...file,
      removed: [{ id: 'd-0', personId: PERSON, removedAt: NOW.toISOString() }],
    }
    const plan = planRestore(historyOf([]), PERSON, inconsistent)
    expect(plan.ok && plan.outcome).toMatchObject({ restored: 0, stayDeleted: 0, deletedThere: 1 })
  })
})

describe('what the screens say (KV-21)', () => {
  const outcome = (over: Partial<RestoreOutcome>): RestoreOutcome => ({
    restored: 0,
    alreadyHere: 0,
    stayDeleted: 0,
    deletedAt: [],
    deletedThere: 0,
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
    expect(describeRestore(outcome({ alreadyHere: 1, deletedThere: 1 }), day)).toBe(
      'None restored: 1 check-in in this file is already here; 1 check-in was deleted where ' +
        'the file was made, and is not restored.',
    )
    // Export 5, delete the 3 oldest, restore the same file (review of #185).
    const pruned = outcome({ alreadyHere: 2, stayDeleted: 3, deletedAt: deleted(3) })
    expect(describeRestore(pruned, day)).toBe(
      'None restored: 2 check-ins in this file are already here; 3 check-ins were deleted on ' +
        'this device on 2026-10-03, and stay deleted.',
    )
    expect(describeRestore(outcome({ restored: 2, deletedThere: 1 }), day)).toBe(
      'Restored 2 check-ins. 1 check-in in it was deleted where the file was made, and is not ' +
        'restored.',
    )
  })

  it('names no day when the skipped ones were deleted on more than one', () => {
    const mixed = ['2026-10-01T10:00:00.000Z', '2026-10-03T10:00:00.000Z']
    expect(describeRestore(outcome({ stayDeleted: 2, deletedAt: mixed }), day)).toBe(
      'None restored: all 2 check-ins in this file were deleted on this device, and stay deleted.',
    )
  })

  it('says why a file was refused, and that nothing changed', () => {
    expect(describeRefusal({ kind: 'newer', of: 'export', version: 3 }, day)).toBe(
      'That file was made by a newer version of Kinvue (export version 3; this one reads ' +
        'version 2). Nothing has been changed. The newer version can restore it.',
    )
    expect(describeRefusal({ kind: 'newer', of: 'record', version: 3 }, day)).toBe(
      'That file was made by a newer version of Kinvue (record format 3; this one reads ' +
        'format 1). Nothing has been changed. The newer version can restore it.',
    )
    // A file that would not open may open next time, and is not called "no export" (#185).
    expect(describeRefusal({ kind: 'unopenable', code: 'EBUSY' }, day)).toBe(
      'That file could not be opened (EBUSY). Another program may be using it, or its ' +
        'permissions may need checking; it is worth another go. Nothing has been changed.',
    )
    const why = 'capturedAt is not a time'
    const entry = { kind: 'entry' as const, position: 3, total: 60, why }
    expect(describeRefusal(entry, day)).toBe(
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

describe('whose an export is: by key, never by id (KV-18)', () => {
  const OTHER_KEY = '22222222-2222-4222-8222-222222222222'
  const v2 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...exportOf(historyOf([on(0)]), ME, NOW),
    ...over,
  })
  const v1 = (): Record<string, unknown> => {
    const { person: _person, ...rest } = exportOf(historyOf([on(0)]), ME, NOW)
    return { ...rest, version: EXPORT_BEFORE_KEYS }
  }
  const BILL: Person = { ...ME, id: 'p-bill', key: OTHER_KEY, name: 'Bill' }

  it('is theirs when a person here has its key', () => {
    expect(whoseExport(v2(), [BILL, ME], [], false)).toEqual({ kind: 'here', personId: PERSON })
  })

  it('is refused when its key was deleted here, saying when', () => {
    const at = '2026-10-03T09:00:00.000Z'
    expect(whoseExport(v2(), [], [{ key: ME.key, id: PERSON, removedAt: at }], false)).toEqual({
      kind: 'refused',
      refusal: { kind: 'person-deleted', removedAt: at },
    })
    // Before a person with its id is even considered.
    expect(whoseExport(v2(), [ME], [{ key: ME.key, id: PERSON, removedAt: at }], false).kind).toBe(
      'refused',
    )
  })

  it('is someone else’s when a person here has its id under another key', () => {
    const sameIdOtherHousehold: Person = { ...ME, key: OTHER_KEY }
    expect(whoseExport(v2(), [sameIdOtherHousehold], [], false)).toEqual({
      kind: 'refused',
      refusal: { kind: 'someone-else' },
    })
  })

  it('refuses its key under another id as its own reason, not as an id clash (review of #207)', () => {
    const sameKeyOtherId: Person = { ...ME, id: 'p-elsewhere' }
    expect(whoseExport(v2(), [sameKeyOtherId], [], false)).toEqual({
      kind: 'refused',
      refusal: {
        kind: 'unreadable',
        why: 'its person’s key belongs to someone on this computer under another id',
      },
    })
    // And the someone-else sentence says only what is true of every way to it.
    expect(describeRefusal({ kind: 'someone-else' }, day)).toBe(
      'That file is the history of someone else, not of anyone on this computer. ' +
        'Nothing has been changed.',
    )
  })

  it('is someone new when nobody here has its key or its id, with its key and name', () => {
    expect(whoseExport(v2(), [BILL], [], false)).toEqual({
      kind: 'new',
      personId: PERSON,
      key: ME.key,
      name: 'Ann',
    })
  })

  it('asks before an export from before keys goes into someone here, naming them', () => {
    expect(whoseExport(v1(), [ME], [], false)).toEqual({
      kind: 'refused',
      refusal: { kind: 'before-keys', into: 'Ann' },
    })
    expect(whoseExport(v1(), [{ ...ME, name: null }], [], false)).toEqual({
      kind: 'refused',
      refusal: { kind: 'before-keys', into: null },
    })
    expect(whoseExport(v1(), [ME], [], true)).toEqual({ kind: 'here', personId: PERSON })
  })

  it('adds an export from before keys whose id nobody here has, asking nothing (review of #207)', () => {
    // Asked, the question vouched for nothing: on a computer without them,
    // "only if they are not already here" is true whatever is pressed.
    expect(whoseExport(v1(), [BILL], [], false)).toEqual({
      kind: 'new',
      personId: PERSON,
      key: null,
      name: null,
    })
  })

  it('keeps a person deleted here deleted through an export from before keys (review of #207)', () => {
    // Exported before keys, then deleted here: the only handle the file gives
    // is the id, so the tombstone keeps it, and is asked before anything else.
    const at = '2026-10-20T09:00:00.000Z'
    const gone = [{ key: ME.key, id: PERSON, removedAt: at }]
    const refused = { kind: 'refused', refusal: { kind: 'person-deleted', removedAt: at } }
    expect(whoseExport(v1(), [], gone, false)).toEqual(refused)
    expect(whoseExport(v1(), [], gone, true)).toEqual(refused)
  })

  it('matches a key in whatever case it is written, so a changed case slips nothing past (review of #207)', () => {
    const at = '2026-10-20T09:00:00.000Z'
    // Letters in it, so a change of case is a change: ME's key is all digits.
    const LETTERED: Person = { ...ME, key: 'abcdef01-abcd-4abc-8abc-abcdefabcdef' }
    const shouted = v2({ person: { key: LETTERED.key.toUpperCase(), name: 'Ann' } })
    expect(shouted.person).not.toEqual({ key: LETTERED.key, name: 'Ann' })
    const gone = [{ key: LETTERED.key, id: PERSON, removedAt: at }]
    expect(whoseExport(shouted, [], gone, false)).toEqual({
      kind: 'refused',
      refusal: { kind: 'person-deleted', removedAt: at },
    })
    expect(whoseExport(shouted, [LETTERED], [], false)).toEqual({ kind: 'here', personId: PERSON })
  })

  it('reads an export’s person before it is trusted, and never the demo’s', () => {
    const refusal = (f: unknown): unknown => {
      const plan = planRestore(historyOf([]), PERSON, f)
      return plan.ok ? 'accepted' : plan.refusal
    }
    expect(refusal(v2({ person: undefined }))).toEqual({
      kind: 'unreadable',
      why: 'it does not say whose it is',
    })
    expect(refusal(v2({ person: { key: 'k', name: 'Ann' } }))).toEqual({
      kind: 'unreadable',
      why: 'its person’s key is not one',
    })
    expect(refusal(v2({ person: { key: ME.key, name: 5 } }))).toEqual({
      kind: 'unreadable',
      why: 'its person’s name is not one',
    })
    const demo = planRestore(historyOf([]), DEMO_PERSON_ID, v2({ personId: DEMO_PERSON_ID }))
    expect(demo.ok ? 'accepted' : demo.refusal).toEqual({
      kind: 'unreadable',
      why: 'it says it is the demo’s, which is never exported',
    })
    // An export from before keys is still read as one.
    expect(refusal(v1())).toBe('accepted')
  })

  it('says why, and what it is asking, in words', () => {
    expect(
      describeRefusal({ kind: 'person-deleted', removedAt: '2026-10-03T09:00:00.000Z' }, day),
    ).toBe(
      'These check-ins were deleted on this computer on 2026-10-03, with their person, and ' +
        'stay deleted. Nothing has been changed.',
    )
    expect(describeRefusal({ kind: 'before-keys', into: 'Ann' }, day)).toBe(
      'This file is from before Kinvue could tell people apart. Restore it into Ann’s ' +
        'check-ins only if they are Ann’s.',
    )
    // Unnamed, the question names them as the screen can: not by a name they lack.
    expect(describeRefusal({ kind: 'before-keys', into: null }, day)).toBe(
      'This file is from before Kinvue could tell people apart. Restore it into the check-ins ' +
        'of the person on this computer who has not been named yet, only if they are theirs.',
    )
    expect(describeAdded(null)).toBe('')
    expect(describeAdded('named')).toBe(' They were not on this computer, so they have been added.')
    expect(describeAdded('unnamed')).toMatch(/added, without a name/)
  })
})
