import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkName,
  checkPerson,
  DEMO_PERSON_ID,
  holdsAsName,
  MAX_NAME_LENGTH,
  ownerOf,
  withPeopleFor,
  type Person,
} from '@core/session/people'
import {
  createJsonSessionStore,
  UnrecognisedRecordError,
  type SessionStore,
} from '@core/session/store'
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
    ...(
      [
        ['a tag character', 0xe0041],
        ['a cancel tag', 0xe007f],
        ['a right-to-left override', 0x202e],
        ['a left-to-right isolate', 0x2066],
        ['a soft hyphen', 0x00ad],
        ['a paragraph separator', 0x2029],
        ['an inhibit-swapping control', 0x206a],
        ['an interlinear annotation anchor', 0xfff9],
      ] as const
    ).map(([what, cp]) => [what, `An${String.fromCodePoint(cp)}n`]),
    ['a line separator', 'Ann\u2028Bill'],
  ])('refuses %s, which reads as nothing', (_, typed) => {
    expect(checkName(typed, [])).toEqual({ ok: false, problem: 'invisible' })
  })

  it('allows the joiners some names are spelled with (review of #200)', () => {
    // Persian "Alireza": its two parts kept apart by a zero-width non-joiner.
    const alireza = String.fromCodePoint(0x0639, 0x0644, 0x06cc, 0x200c, 0x0631, 0x0636, 0x0627)
    expect(checkName(alireza, [])).toEqual({ ok: true, name: alireza })
    // Devanagari, with a zero-width joiner asking for a half form inside a letter.
    const half = String.fromCodePoint(0x0915, 0x094d, 0x200d, 0x0937)
    expect(checkName(half, [])).toEqual({ ok: true, name: half })
  })

  it('takes a joiner that draws nothing as no difference, and refuses one at an end (second review of #200)', () => {
    const zwj = String.fromCodePoint(0x200d)
    const zwnj = String.fromCodePoint(0x200c)
    // Between Latin letters a joiner draws nothing: "Ann" twice on two buttons.
    expect(checkName(`An${zwj}n`, [person()])).toEqual({ ok: false, problem: 'taken' })
    expect(checkName(`An${zwnj}n`, [person()])).toEqual({ ok: false, problem: 'taken' })
    // At either end it joins nothing.
    expect(checkName(`Ann${zwnj}`, [])).toEqual({ ok: false, problem: 'invisible' })
    expect(checkName(`${zwj}Ann`, [])).toEqual({ ok: false, problem: 'invisible' })
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
    // Folded, not only lowered: an eszett reads as the "SS" it upper-cases to
    // (review of #200).
    const strasse = [person({ id: 'p-3', name: 'Straße' })]
    expect(checkName('STRASSE', strasse)).toEqual({ ok: false, problem: 'taken' })
    expect(checkName('strasse', strasse)).toEqual({ ok: false, problem: 'taken' })
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
    // Only that a name is text: whether it holds is `holdsAsName` (second review of #200).
    ['a name that is not text', { ...person(), name: 5 }, 'its name is not one'],
    ['a key that is not a UUID', person({ key: 'k' }), 'its key is not one'],
    ['a time that is not one', person({ addedAt: 'yesterday' }), 'when it was added is not a time'],
    // Held to what writing one would allow (review of #200).
    [
      'the demo',
      person({ id: DEMO_PERSON_ID }),
      'it is the demo, which is never a person on the list',
    ],
  ])('refuses %s', (_, value, why) => {
    expect(checkPerson(value)).toBe(why)
  })
})

describe('a name, read back from the file (second review of #200)', () => {
  it('holds when the rule would write it as it is stored', () => {
    expect(holdsAsName('Ann')).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['not stored trimmed', 'Ann '],
    ['too long to be typed in', 'a'.repeat(MAX_NAME_LENGTH + 1)],
    ['holding a zero-width space', `An${String.fromCodePoint(0x200b)}n`],
    ['not in NFC', `Jose${String.fromCodePoint(0x0301)}`],
  ])('does not hold %s', (_, name) => {
    expect(holdsAsName(name)).toBe(false)
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

  it('reads a name that does not hold, or is taken already, as none, refusing nothing (second review of #200)', async () => {
    const path = await pathIn()
    const people = [
      person(),
      person({ id: 'p-2', name: 'ANN' }),
      person({ id: 'p-3', name: 'a'.repeat(MAX_NAME_LENGTH + 1) }),
      person({ id: 'p-4', name: `An${String.fromCodePoint(0x200b)}n` }),
      person({ id: 'p-5', name: '' }),
      person({ id: 'p-6', name: 'Bill' }),
    ]
    const file = { version: 2, sessions: [{ ...session({ id: 'one' }), personId: 'p-1' }], people }
    await writeFile(path, JSON.stringify(file), 'utf8')
    const store = createJsonSessionStore(path, () => NOW)
    expect((await store.people()).map((p) => [p.id, p.name])).toEqual([
      ['p-1', 'Ann'],
      ['p-2', null],
      ['p-3', null],
      ['p-4', null],
      ['p-5', null],
      ['p-6', 'Bill'],
    ])
    // The check-ins read as ever, and a read writes nothing.
    expect((await store.list('p-1')).map((s) => s.id)).toEqual(['one'])
    expect(await onDisk(path)).toEqual(file)
  })

  it('adds a second person beside the first, each with an id and key of their own', async () => {
    const path = await pathIn()
    const store = createJsonSessionStore(path, () => NOW)
    const ann = await store.addPerson('Ann')
    const bill = await store.addPerson('Bill')
    if (!ann.ok || !bill.ok) throw new Error('not added')
    expect((await store.people()).map((p) => p.name)).toEqual(['Ann', 'Bill'])
    expect(bill.person.id).not.toBe(ann.person.id)
    expect(bill.person.key).not.toBe(ann.person.key)
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

  describe('deleting a person (KV-18)', () => {
    const AT = new Date('2026-10-20T09:00:00.000Z')
    const ANN_KEY = '11111111-1111-4111-8111-111111111111'
    const BILL_KEY = '22222222-2222-4222-8222-222222222222'
    const theirs = (personId: string, id: string): SessionRecord => ({
      ...session({ id }),
      personId,
    })
    const household = {
      version: 2,
      sessions: [
        theirs('p-ann', 'a-1'),
        theirs('p-bill', 'b-1'),
        theirs('p-ann', 'a-2'),
        // Seeded under Ann's id before KV-18: the demo's, so it stays.
        { ...theirs('p-ann', 'seed-1'), seeded: true as const },
      ],
      people: [
        person({ id: 'p-ann', key: ANN_KEY, name: 'Ann' }),
        person({ id: 'p-bill', key: BILL_KEY, name: 'Bill' }),
      ],
      lastExported: { 'p-ann': NOW.toISOString(), 'p-bill': NOW.toISOString() },
    }

    it('removes them, their check-ins and their export time, and keeps their key, in one write', async () => {
      const path = await pathIn()
      await writeFile(path, JSON.stringify(household), 'utf8')
      const store = createJsonSessionStore(path, () => NOW)

      expect(await store.removePerson('p-ann', AT)).toBe(2)
      const written = await onDisk(path)
      expect(written.version).toBe(3)
      expect(written.people).toEqual([household.people[1]])
      expect((written.sessions as SessionRecord[]).map((r) => r.id)).toEqual(['b-1', 'seed-1'])
      // Each check-in keeps KV-21's tombstone; the person keeps theirs: a key
      // and a time, no name, no id.
      expect(written.removed).toEqual([
        { id: 'a-1', personId: 'p-ann', removedAt: AT.toISOString() },
        { id: 'a-2', personId: 'p-ann', removedAt: AT.toISOString() },
      ])
      expect(written.removedPeople).toEqual([{ key: ANN_KEY, removedAt: AT.toISOString() }])
      expect(JSON.stringify(written.removedPeople)).not.toMatch(/Ann|p-ann/)
      expect(written.lastExported).toEqual({ 'p-bill': NOW.toISOString() })
      // And it reads back: Bill's history as it was, Ann nowhere.
      expect((await store.people()).map((p) => p.name)).toEqual(['Bill'])
      expect(await store.list('p-ann')).toEqual([])
    })

    it('stores no check-in for someone deleted, though their reading was waiting (review of #206)', async () => {
      const path = await pathIn()
      await writeFile(path, JSON.stringify(household), 'utf8')
      const store = createJsonSessionStore(path, () => NOW)
      await store.removePerson('p-ann', AT)
      const before = await readFile(path, 'utf8')

      // A check-in's way in: refused, in the same turn as the write would be.
      await expect(
        store.append(theirs('p-ann', 'late'), { onlyIfListed: true }),
      ).rejects.toThrow(/nobody with the id p-ann/)
      expect(await readFile(path, 'utf8')).toBe(before)
      expect((await store.people()).map((p) => p.name)).toEqual(['Bill'])
      // Someone on the list is stored as ever.
      await store.append(theirs('p-bill', 'b-2'), { onlyIfListed: true })
      expect((await store.list('p-bill')).map((r) => r.id)).toEqual(['b-1', 'b-2'])
    })

    it('refuses someone not on the list, the demo included, and writes nothing', async () => {
      const path = await pathIn()
      const text = JSON.stringify(household)
      await writeFile(path, text, 'utf8')
      const store = createJsonSessionStore(path, () => NOW)
      await expect(store.removePerson('p-nobody', AT)).rejects.toThrow(/nobody with the id/)
      await expect(store.removePerson(DEMO_PERSON_ID, AT)).rejects.toThrow(/nobody with the id/)
      expect(await readFile(path, 'utf8')).toBe(text)
    })

    it('reads a version-2 file without writing it, and says 3 only once someone is deleted (review of #206)', async () => {
      const path = await pathIn()
      const text = JSON.stringify(household)
      await writeFile(path, text, 'utf8')
      const store = createJsonSessionStore(path, () => NOW)
      expect((await store.people()).map((p) => p.name)).toEqual(['Ann', 'Bill'])
      expect(await readFile(path, 'utf8')).toBe(text)
      // Nobody deleted: still a file a build that knows only 2 can read, so a
      // household rolled back to one loses nothing.
      await store.rename('p-bill', 'William')
      expect((await onDisk(path)).version).toBe(2)
      await store.removePerson('p-ann', AT)
      expect((await onDisk(path)).version).toBe(3)
      // And 3 from then on: the record of Ann stays, and so does what it needs.
      await store.rename('p-bill', 'Will')
      expect((await onDisk(path)).version).toBe(3)
    })

    it('checks the deleted people of a version-1 file too, before its upgrade writes it (review of #206)', async () => {
      const path = await pathIn()
      // A version-1 file carrying a list it should not: hand-edited, or synced
      // down from a newer build. Upgraded unchecked, it was written back as
      // version 3 and every read after refused it.
      const text = JSON.stringify({
        version: 1,
        sessions: [theirs('p-ann', 'a-1')],
        removedPeople: [{ key: 'k', removedAt: AT.toISOString() }],
      })
      await writeFile(path, text, 'utf8')
      const thrown = await createJsonSessionStore(path, () => NOW).people().catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(UnrecognisedRecordError)
      expect(String(thrown)).toMatch(/Deleted person 1 of 1 .* \(its key is not one\)/)
      expect(await readFile(path, 'utf8')).toBe(text)
    })

    it('refuses a file whose record of a deleted person it cannot read, and names the list', async () => {
      const path = await pathIn()
      const store = createJsonSessionStore(path, () => NOW)
      for (const [removedPeople, pattern] of [
        [{}, /list of deleted people .* cannot be read \(it is not a list\)/],
        [
          [{ key: ANN_KEY, removedAt: AT.toISOString() }, { key: 'k', removedAt: AT.toISOString() }],
          /Deleted person 2 of 2 .* \(its key is not one\)/,
        ],
        [[{ key: ANN_KEY, removedAt: 'yesterday' }], /Deleted person 1 of 1 .* \(when it was/],
      ] as const) {
        await writeFile(path, JSON.stringify({ ...household, version: 3, removedPeople }), 'utf8')
        const thrown = await store.people().catch((e: unknown) => e)
        expect(thrown).toBeInstanceOf(UnrecognisedRecordError)
        expect(String(thrown)).toMatch(pattern)
      }
    })
  })

  describe('restoring by key (KV-18)', () => {
    const AT = new Date('2026-10-20T09:00:00.000Z')
    /** A store holding Ann, named, with two check-ins, and the export of her. */
    const annsExport = async (): Promise<{ from: SessionStore; exported: unknown }> => {
      const from = createJsonSessionStore(await pathIn(), () => NOW)
      const ann = await from.addPerson('Ann')
      if (!ann.ok) throw new Error('not added')
      for (const id of ['a-1', 'a-2']) {
        await from.append({ ...session({ id }), personId: ann.person.id })
      }
      const exported = JSON.parse(JSON.stringify(await from.exportFor(ann.person.id, AT)))
      return { from, exported: exported as unknown }
    }

    it('exports only someone on the list, with their key and name', async () => {
      const { from, exported } = await annsExport()
      const [ann] = await from.people()
      expect(exported).toMatchObject({ version: 2, person: { key: ann?.key, name: 'Ann' } })
      await expect(from.exportFor(DEMO_PERSON_ID, AT)).rejects.toThrow(/nobody with the id/)
    })

    it('adds someone not on this computer, with their key and name, in the same write', async () => {
      const { from, exported } = await annsExport()
      const path = await pathIn()
      const to = createJsonSessionStore(path, () => NOW)
      await to.addPerson('Bill')

      const result = await to.restore(exported)
      const [ann] = await from.people()
      expect(result.ok && result.into).toEqual({ personId: ann?.id, added: 'named' })
      expect((await to.people()).map((p) => [p.name, p.key])).toEqual([
        ['Bill', expect.any(String)],
        ['Ann', ann?.key],
      ])
      expect((await to.list(ann?.id ?? '')).map((r) => r.id)).toEqual(['a-1', 'a-2'])

      // Again: the same person, by key, and nothing new.
      const again = await to.restore(exported)
      expect(again.ok && again.into).toEqual({ personId: ann?.id, added: null })
      expect(again.ok && again.outcome).toMatchObject({ restored: 0, alreadyHere: 2 })
    })

    it('adds them without a name when theirs is taken here, rather than two people under one', async () => {
      const { exported } = await annsExport()
      const to = createJsonSessionStore(await pathIn(), () => NOW)
      await to.addPerson('ann')
      const result = await to.restore(exported)
      expect(result.ok && result.into.added).toBe('unnamed')
      expect((await to.people()).map((p) => p.name)).toEqual(['ann', null])
    })

    it('refuses the export of someone deleted here, and writes nothing', async () => {
      const { from, exported } = await annsExport()
      const [ann] = await from.people()
      await from.removePerson(ann?.id ?? '', AT)
      const result = await from.restore(exported)
      expect(result).toEqual({
        ok: false,
        refusal: { kind: 'person-deleted', removedAt: AT.toISOString() },
      })
      expect(await from.people()).toEqual([])
      expect(await from.list(ann?.id ?? '')).toEqual([])
    })

    it('asks before restoring an export from before keys, and writes only once told', async () => {
      const path = await pathIn()
      await writeFile(
        path,
        JSON.stringify({
          version: 2,
          sessions: [{ ...session({ id: 'here' }), personId: 'demo-margaret' }],
          people: [person({ id: 'demo-margaret', name: 'Ann' })],
        }),
        'utf8',
      )
      const store = createJsonSessionStore(path, () => NOW)
      const before = {
        kind: 'kinvue-history',
        version: 1,
        exportedAt: AT.toISOString(),
        personId: 'demo-margaret',
        records: [{ ...session({ id: 'old' }), personId: 'demo-margaret' }],
        removed: [],
      }
      const text = await readFile(path, 'utf8')
      expect(await store.restore(before)).toEqual({
        ok: false,
        refusal: { kind: 'before-keys', into: 'Ann' },
      })
      expect(await readFile(path, 'utf8')).toBe(text)

      const told = await store.restore(before, { confirmed: true })
      expect(told.ok && told.into).toEqual({ personId: 'demo-margaret', added: null })
      expect((await store.list('demo-margaret')).map((r) => r.id).sort()).toEqual(['here', 'old'])
    })
  })

  it('answers who is here and whether the demo has days in one read', async () => {
    const path = await pathIn()
    const store = createJsonSessionStore(path, () => NOW)
    expect(await store.roster()).toEqual({ people: [], demo: false, checkedIn: false })
    await store.append(session({ id: 'one' }))
    expect((await store.roster()).demo).toBe(false)
    // A day seeded under a real person's id before KV-18 is still the demo's.
    await store.append({ ...session({ id: 'seed-1', seeded: true }), personId: 'test-person' })
    const roster = await store.roster()
    expect(roster.demo).toBe(true)
    // Its own check-in counts; the seeded day, though written under its id, does not.
    expect(roster.checkedIn).toBe(true)
    expect(roster.people.map((p) => p.id)).toEqual(['test-person'])
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
