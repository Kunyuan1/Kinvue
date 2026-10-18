import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkName,
  checkPerson,
  DEMO_PERSON_ID,
  MAX_NAME_LENGTH,
  ownerOf,
  withPeopleFor,
  type Person,
} from '@core/session/people'
import { createJsonSessionStore, UnrecognisedRecordError } from '@core/session/store'
import { presentAll } from '@core/scoring'
import { trendOf } from '@core/trend'
import type { SessionRecord } from '@core/session/types'
import { session } from './helpers'

/**
 * More than one person on a computer (KV-18, ARCHITECTURE.md): the name rule,
 * the people list kept in the history file, the version-1 file upgraded as it
 * is read, the demo's days read as the demo's, and baselines that never mix.
 */

const KEY = '00000000-0000-4000-8000-000000000000'
const person = (over: Partial<Person> = {}): Person => ({
  id: 'p-1',
  key: KEY,
  name: 'Ann',
  addedAt: '2026-10-01T09:00:00.000Z',
  ...over,
})

describe('a name, held to how it reads (KV-18)', () => {
  it('is stored trimmed and in NFC, so one typed two ways is one name', () => {
    const decomposed = 'Jose\u0301' // "José" with the accent as its own code point
    const result = checkName(`  ${decomposed} `, [])
    expect(result).toEqual({ ok: true, name: 'José' })
  })

  it('trims what `trim` counts as space at either end, a byte-order mark among it', () => {
    expect(checkName('\uFEFFAnn\u00A0', [])).toEqual({ ok: true, name: 'Ann' })
  })

  it('refuses nothing, and a name that is only space', () => {
    expect(checkName('', [])).toEqual({ ok: false, problem: 'empty' })
    expect(checkName('   ', [])).toEqual({ ok: false, problem: 'empty' })
  })

  it.each([
    ['a zero-width space', 'An\u200Bn'],
    ['a byte-order mark inside it', 'An\uFEFFn'],
    ['a right-to-left mark', 'Ann\u200F'],
    ['a control character', 'An\u0007n'],
    ['a line separator', 'Ann\u2028Bill'],
  ])('refuses %s, which reads as nothing', (_, typed) => {
    expect(checkName(typed, [])).toEqual({ ok: false, problem: 'invisible' })
  })

  it(`allows ${String(MAX_NAME_LENGTH)} characters as a person counts them, not one more`, () => {
    expect(checkName('a'.repeat(MAX_NAME_LENGTH), []).ok).toBe(true)
    expect(checkName('a'.repeat(MAX_NAME_LENGTH + 1), [])).toEqual({
      ok: false,
      problem: 'too-long',
    })
    // Forty letters with an accent NFC cannot fold into one code point are
    // eighty code points, and forty letters on the button.
    expect(checkName('q\u0301'.repeat(MAX_NAME_LENGTH), []).ok).toBe(true)
    expect(checkName('q\u0301'.repeat(MAX_NAME_LENGTH + 1), [])).toEqual({
      ok: false,
      problem: 'too-long',
    })
  })

  it('refuses a name another person reads the same as: case, space and accent aside', () => {
    const others = [person({ name: 'Ann' }), person({ id: 'p-2', name: 'José' })]
    expect(checkName('ann ', others)).toEqual({ ok: false, problem: 'taken' })
    expect(checkName('ANN', others)).toEqual({ ok: false, problem: 'taken' })
    expect(checkName('jose\u0301', others)).toEqual({ ok: false, problem: 'taken' })
    expect(checkName('Anne', others)).toEqual({ ok: true, name: 'Anne' })
  })

  it('compares against named people only: one waiting for a name takes none', () => {
    expect(checkName('Ann', [person({ name: null })])).toEqual({ ok: true, name: 'Ann' })
  })
})

describe('a person, checked as it is read', () => {
  it('accepts one well formed, unnamed or named', () => {
    expect(checkPerson(person())).toBeNull()
    expect(checkPerson(person({ name: null }))).toBeNull()
  })

  it.each([
    ['not an object', 'Ann', 'it is not a person'],
    ['an id with space around it', person({ id: ' p-1' }), 'its id is not one'],
    ['a key that is not a UUID', person({ key: 'k' }), 'its key is not one'],
    ['an empty name', person({ name: '' }), 'its name is not one'],
    ['a name not stored trimmed', person({ name: 'Ann ' }), 'its name is not one'],
    ['a time that is not one', person({ addedAt: 'yesterday' }), 'when it was added is not a time'],
  ])('refuses %s', (_, value, why) => {
    expect(checkPerson(value)).toBe(why)
  })
})

describe('whose a record is', () => {
  it('is the demo’s for a seeded day, whatever it was written under, and its own otherwise', () => {
    expect(ownerOf(session({ seeded: true }))).toBe(DEMO_PERSON_ID)
    expect(ownerOf({ ...session({ seeded: true }), personId: 'demo-margaret' })).toBe(
      DEMO_PERSON_ID,
    )
    expect(ownerOf(session())).toBe('test-person')
  })

  it('adds a person for each real id without one, in the order of their first check-in', () => {
    let n = 0
    const key = (): string => `00000000-0000-4000-8000-00000000000${String(++n)}`
    const at = new Date('2026-10-18T10:00:00.000Z')
    const records: SessionRecord[] = [
      { ...session({ id: 'b', capturedAt: '2026-09-02T09:00:00.000Z' }), personId: 'bill' },
      { ...session({ id: 'a', capturedAt: '2026-09-01T09:00:00.000Z' }), personId: 'ann' },
      { ...session({ id: 's', capturedAt: '2026-08-01T09:00:00.000Z', seeded: true }) },
      { ...session({ id: 'a2', capturedAt: '2026-09-03T09:00:00.000Z' }), personId: 'ann' },
    ]
    const people = withPeopleFor([person({ id: 'bill', name: 'Bill' })], records, key, at)
    expect(people.map((p) => [p.id, p.name])).toEqual([
      ['bill', 'Bill'],
      ['ann', null],
    ])
    expect(people[1]).toEqual({
      id: 'ann',
      key: '00000000-0000-4000-8000-000000000001',
      name: null,
      addedAt: at.toISOString(),
    })
    // Nobody for the seeded day: it is the demo's.
    expect(people.some((p) => p.id === DEMO_PERSON_ID || p.id === 'test-person')).toBe(false)
  })
})

describe('the people list in the history file (KV-18)', () => {
  const dirs: string[] = []
  const pathIn = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'kinvue-people-'))
    dirs.push(dir)
    return join(dir, 'sessions.json')
  }
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(async (d) => rm(d, { recursive: true, force: true })))
  })
  const NOW = new Date('2026-10-18T10:00:00.000Z')
  const onDisk = async (path: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  describe('a version-1 file', () => {
    const real = {
      ...session({ id: 'r-1', capturedAt: '2026-09-02T09:00:00.000Z' }),
      personId: 'demo-margaret',
    }
    const seeded = {
      ...session({
        id: 'seed-demo-margaret-1',
        capturedAt: '2026-09-01T09:00:00.000Z',
        seeded: true,
      }),
      personId: 'demo-margaret',
    }
    const v1 = {
      version: 1,
      sessions: [seeded, real],
      lastExported: { 'demo-margaret': NOW.toISOString() },
    }

    it('is upgraded as it is read, and written as version 2 at once, every record as it was', async () => {
      const path = await pathIn()
      await writeFile(path, JSON.stringify(v1), 'utf8')
      const store = createJsonSessionStore(path, () => NOW)

      const people = await store.people()
      expect(people).toEqual([
        {
          id: 'demo-margaret',
          key: expect.stringMatching(UUID),
          name: null,
          addedAt: NOW.toISOString(),
        },
      ])
      // Written by that read — not left for some later write to do.
      const written = await onDisk(path)
      expect(written).toEqual({ ...v1, version: 2, people })
    })

    it('keeps one key however many reads come first, queued or at once', async () => {
      const path = await pathIn()
      await writeFile(path, JSON.stringify(v1), 'utf8')
      const store = createJsonSessionStore(path, () => NOW)
      const [a, , b] = await Promise.all([
        store.people(),
        store.list('demo-margaret'),
        store.people(),
      ])
      const c = await createJsonSessionStore(path, () => NOW).people()
      expect(a[0]?.key).toMatch(UUID)
      expect(b[0]?.key).toBe(a[0]?.key)
      expect(c[0]?.key).toBe(a[0]?.key)
    })

    it('makes nobody of a history that is only the demo', async () => {
      const path = await pathIn()
      await writeFile(path, JSON.stringify({ version: 1, sessions: [seeded] }), 'utf8')
      expect(await createJsonSessionStore(path, () => NOW).people()).toEqual([])
    })

    it('reads its seeded days as the demo’s, and the real person’s without them', async () => {
      const path = await pathIn()
      await writeFile(path, JSON.stringify(v1), 'utf8')
      const store = createJsonSessionStore(path, () => NOW)
      expect((await store.list('demo-margaret')).map((r) => r.id)).toEqual(['r-1'])
      const demo = await store.list(DEMO_PERSON_ID)
      expect(demo.map((r) => [r.id, r.personId])).toEqual([
        ['seed-demo-margaret-1', DEMO_PERSON_ID],
      ])
      // And on disk the seeded day is as it was written: nothing moved.
      expect((await onDisk(path)).sessions).toEqual([seeded, real])
    })
  })

  it('refuses a version-2 file whose people it cannot read, and names the list', async () => {
    const path = await pathIn()
    const store = createJsonSessionStore(path, () => NOW)
    for (const [people, pattern] of [
      [undefined, /list of people .* cannot be read \(it is not a list\)/],
      [[person(), { ...person(), key: 'k' }], /Person 2 of 2 .* \(its key is not one\)/],
      [[person(), person({ name: 'Bill' })], /Person 2 of 2 .* \(its id is used twice\)/],
    ] as const) {
      await writeFile(path, JSON.stringify({ version: 2, sessions: [], people }), 'utf8')
      const thrown = await store.people().catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(UnrecognisedRecordError)
      expect(String(thrown)).toMatch(pattern)
    }
  })

  it('adds someone under a name held to the rule, with ids and keys of their own', async () => {
    const path = await pathIn()
    const store = createJsonSessionStore(path, () => NOW)
    const added = await store.addPerson('  Ann ')
    expect(added).toEqual({
      ok: true,
      person: {
        id: expect.stringMatching(UUID),
        key: expect.stringMatching(UUID),
        name: 'Ann',
        addedAt: NOW.toISOString(),
      },
    })
    if (!added.ok) throw new Error('not added')
    expect(added.person.id).not.toBe(added.person.key)
    expect(await store.addPerson('ann')).toEqual({ ok: false, problem: 'taken' })
    expect(await store.people()).toEqual([added.person])
  })

  it('names a person, or renames them, changing no check-in', async () => {
    const path = await pathIn()
    const store = createJsonSessionStore(path, () => NOW)
    await store.append(session({ id: 'one' }))
    const [unnamed] = await store.people()
    expect(unnamed?.name).toBeNull()
    const sessionsBefore = (await onDisk(path)).sessions

    const named = await store.rename('test-person', 'ann')
    expect(named).toEqual({ ok: true, person: { ...unnamed, name: 'ann' } })
    // Their own name in another case is still theirs to take.
    expect(await store.rename('test-person', 'Ann')).toEqual({
      ok: true,
      person: { ...unnamed, name: 'Ann' },
    })
    expect(await store.rename('test-person', '\u200B')).toEqual({ ok: false, problem: 'invisible' })
    expect((await onDisk(path)).sessions).toEqual(sessionsBefore)
    await expect(store.rename('nobody', 'Bill')).rejects.toThrow(/nobody with the id nobody/)
  })

  it('adds a person when a real check-in arrives for someone it lacks, and nobody for a seeded one', async () => {
    const path = await pathIn()
    const store = createJsonSessionStore(path, () => NOW)
    await store.append(session({ id: 'seed', seeded: true }))
    expect(await store.people()).toEqual([])
    await store.append(session({ id: 'one' }))
    await store.append(session({ id: 'two' }))
    expect((await store.people()).map((p) => [p.id, p.name])).toEqual([['test-person', null]])
  })
})

describe('baselines never mix (KV-18)', () => {
  // Two people with very different usuals, their check-ins interleaved day by
  // day in one file, as a household's would be.
  const days = (personId: string, pulse: number, hour: number): SessionRecord[] =>
    Array.from({ length: 8 }, (_, i) => ({
      ...session({
        id: `${personId}-${String(i)}`,
        capturedAt: new Date(Date.UTC(2026, 8, i + 1, hour)).toISOString(),
        vitals: { pulseRateBpm: pulse + (i % 3) },
      }),
      personId,
    }))
  const ann = days('ann', 62, 8)
  const bill = days('bill', 96, 9)
  const together = [...ann, ...bill].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  it('scores each person’s check-ins in one file exactly as each would alone', () => {
    const both = presentAll(together)
    for (const alone of [ann, bill]) {
      const own = presentAll(alone)
      for (const record of alone) expect(both.get(record.id), record.id).toEqual(own.get(record.id))
    }
  })

  it('draws a person’s trend from their own check-ins only', () => {
    const trend = trendOf(together, 'ann', 'pulse')
    expect(trend).toEqual(trendOf(ann, 'ann', 'pulse'))
  })
})
