import type { NameProblem, Person } from '@core/session/people'

/**
 * A person as the screens see them (KV-18): who, and what they are called. Not
 * their key, which tells them from another person across computers and has no
 * use on a screen.
 */
export interface PersonShown {
  id: string
  /** Null for a history from before KV-18 not yet told whose it is. */
  name: string | null
}

/** Who takes readings here, and whether the demo has days to show. */
export interface PeopleNow {
  people: PersonShown[]
  demo: boolean
}

/** What naming someone came to: the person as now named, or why the name was not taken. */
export type NamedResult = { ok: true; person: PersonShown } | { ok: false; problem: NameProblem }

export const shown = ({ id, name }: Person): PersonShown => ({ id, name })

export const namedResult = (
  result: { ok: true; person: Person } | { ok: false; problem: NameProblem },
): NamedResult => (result.ok ? { ok: true, person: shown(result.person) } : result)
