import type { SessionRecord } from './types'

/**
 * The people on one check-in computer (KV-18): a household, each with their own
 * history, kept in the history file beside their check-ins and sealed with them.
 * See ARCHITECTURE.md, "More than one person on a computer".
 */

/** One person who takes readings on this computer. */
export interface Person {
  /**
   * What their records carry as `personId`. A random UUID for anyone added
   * since KV-18; `demo-margaret` for a history from before, which is kept
   * rather than rewritten (KV-30).
   */
  id: string
  /**
   * Tells this person from another across computers (KV-18): an id need not —
   * `demo-margaret` is the same on every install that ran the demo — so an
   * export is matched to its person by this. A random UUID, never shown, and
   * never in a share.
   */
  key: string
  /**
   * How the screens tell people apart, held to `checkName`. Null only for a
   * history from before KV-18 that has not yet been told whose it is: the app
   * asks once.
   */
  name: string | null
  /** When they were added to this computer's list. */
  addedAt: string
}

/**
 * The demo's own id (KV-18). Never a person on the list, never offered a
 * reading: a person of invented days, for seeing the dashboard with a baseline
 * behind it. It used to be `demo-margaret`, which is now a real person's id
 * wherever the demo had been used for real check-ins — so seeding, and the
 * check that refuses to seed twice, use this one.
 */
export const DEMO_PERSON_ID = 'kinvue-demo'

/**
 * Whose a record is, as everything that reads the history sees it (KV-18).
 *
 * A seeded day is the demo's, whatever `personId` it was written with: days
 * seeded before KV-18 sit under `demo-margaret`, beside a real person's
 * check-ins. They are read as the demo's here and never written back — moving
 * them would rewrite records, which KV-30 rules out — so a real person's
 * baseline stops counting them, with the file as it was.
 */
export const ownerOf = (record: SessionRecord): string =>
  record.seeded === true ? DEMO_PERSON_ID : record.personId

/** The longest a name may be: drawn on the path at 18px (KV-20), so a number, as every cap is. */
export const MAX_NAME_LENGTH = 40

/** Why a name was not taken. */
export type NameProblem = 'empty' | 'too-long' | 'invisible' | 'taken'

/**
 * Control characters, and the ones that draw nothing — a zero-width space, the
 * byte-order mark, the bidirectional marks and controls, a soft hyphen — any of
 * which would make two names that read the same compare as different (KV-18).
 *
 * Listed by code point, not as every format character (`\p{Cf}`): that took in
 * the zero-width non-joiner and joiner, which are how some names are *spelled* —
 * Persian "Alireza" has a non-joiner between its parts, and several Indic
 * scripts carry the joiner inside a letter — so a caregiver typing the name
 * correctly could not name the person at all (review of #200). Those two do
 * change how a name draws, so names that differ by one do not read the same.
 * Numbers, not escapes, so no tool can write them back as the characters.
 */
const CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]/u
const DRAW_NOTHING = new Set([
  0x00ad, // soft hyphen
  0x061c, // Arabic letter mark
  0x180e, // Mongolian vowel separator
  0x200b, // zero-width space
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // bidirectional embeddings, overrides and their end
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2060, // word joiner, and the invisible operators
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0x2066, // bidirectional isolates and their end
  0x2067,
  0x2068,
  0x2069,
  0xfeff, // byte-order mark, which draws nothing inside a name
])
const holdsInvisible = (name: string): boolean =>
  CONTROLS.test(name) || [...name].some((c) => DRAW_NOTHING.has(c.codePointAt(0) ?? 0))

/** A name as it is stored: trimmed, in Unicode NFC, so "José" is one name however it was typed. */
export const normalName = (typed: string): string => typed.normalize('NFC').trim()

/** Made once: building one resolves a locale, and it holds no state (review of #200). */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** How many characters `text` draws as: grapheme clusters, as a reader counts them. */
const charactersIn = (text: string): number => [...GRAPHEMES.segment(text)].length

/**
 * The form two names are compared in: the stored form, case-folded. Upper then
 * lower, because lowering alone is not folding: "Straße" lowers to itself and
 * "STRASSE" to "strasse", two names that read the same (review of #200), while
 * upper-casing first makes the ß "SS". Still not every rule of Unicode's full
 * folding — a few scripts' special cases differ — and those are the limit.
 */
export const comparable = (name: string): string =>
  normalName(name).toLocaleUpperCase('und').toLocaleLowerCase('und')

/**
 * Whether `typed` may name a person beside `others`, and if so the name to
 * store. The rule is about how a name reads, not its bytes: two buttons a
 * person picks themselves from must never read the same (KV-18).
 */
export function checkName(
  typed: string,
  others: readonly Person[],
): { ok: true; name: string } | { ok: false; problem: NameProblem } {
  const name = normalName(typed)
  if (name === '') return { ok: false, problem: 'empty' }
  if (holdsInvisible(name)) return { ok: false, problem: 'invisible' }
  // Counted as a person reads them — characters as drawn, not UTF-16 units or
  // code points: a letter with an accent that has no single code point (NFC
  // leaves "q" and its accent as two) is one character on the button.
  if (charactersIn(name) > MAX_NAME_LENGTH) return { ok: false, problem: 'too-long' }
  const folded = comparable(name)
  if (others.some((p) => p.name !== null && comparable(p.name) === folded)) {
    return { ok: false, problem: 'taken' }
  }
  return { ok: true, name }
}

/**
 * What each problem says, beside the name field. `empty` is for the bridge:
 * the field cannot be sent blank (`NameField`), so it is what main says to a
 * caller that sends one anyway.
 */
export const NAME_PROBLEM: Record<NameProblem, string> = {
  empty: 'A name is needed, so the check-ins say whose they are.',
  'too-long': `A name can be up to ${String(MAX_NAME_LENGTH)} characters.`,
  invisible: 'That name has a character in it that does not show. Try typing it again.',
  taken: 'Someone on this computer already has that name. Try another, such as a surname.',
}

/**
 * Why `value` is not a person this build can keep, or null (KV-181's habit:
 * every field checked as it is read, refused whole).
 */
export function checkPerson(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'it is not a person'
  }
  const { id, key, name, addedAt } = value as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || id.trim() !== id) return 'its id is not one'
  // The demo is never on the list (review of #200): there, main would allow a
  // reading as it, and a real check-in would be stored among invented days.
  if (id === DEMO_PERSON_ID) return 'it is the demo, which is never a person on the list'
  if (typeof key !== 'string' || !UUID.test(key)) return 'its key is not one'
  // Held to the rule a name is written under, read back as it is: a name that
  // could not be typed in could not be shown either (review of #200).
  if (name !== null) {
    if (typeof name !== 'string') return 'its name is not one'
    const held = checkName(name, [])
    if (!held.ok || held.name !== name) return 'its name is not one'
  }
  if (typeof addedAt !== 'string' || Number.isNaN(Date.parse(addedAt))) {
    return 'when it was added is not a time'
  }
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `people`, with a person added for any real record whose `personId` has none,
 * in the order their first check-in was taken. Unnamed, with a fresh key.
 *
 * How a history from before KV-18 gets its people when it is upgraded, and how
 * the list stays whole when a record arrives for someone it lacks. Seeded days
 * add nobody: they are the demo's (`ownerOf`).
 */
export function withPeopleFor(
  people: readonly Person[],
  records: readonly SessionRecord[],
  makeKey: () => string,
  now: Date,
): Person[] {
  const known = new Set(people.map((p) => p.id))
  const added: Person[] = []
  const inOrder = [...records].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  for (const record of inOrder) {
    const id = ownerOf(record)
    if (id === DEMO_PERSON_ID || known.has(id)) continue
    known.add(id)
    added.push({ id, key: makeKey(), name: null, addedAt: now.toISOString() })
  }
  return added.length === 0 ? [...people] : [...people, ...added]
}
