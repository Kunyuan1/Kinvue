/**
 * What this device can honestly say about where it is.
 *
 * MAIN PROCESS ONLY by intent, though it imports nothing: the zone belongs to
 * the machine holding the camera, not to whoever is reading later.
 */

/**
 * The device's IANA zone, or undefined when it cannot be established.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` answers `'UTC'` in two
 * very different situations: a device genuinely on UTC, and a device whose zone
 * could not be resolved at all — a container with no tzdata, a stripped
 * packaged build, a bogus `TZ`. Writing `'UTC'` for the second case is a guess,
 * and an indelible one: a check-in taken at 08:00 in Tokyo would be filed on the
 * previous day forever, with nothing on the record to show the zone was
 * invented. `core/session/time.ts` refuses to guess a zone when reading; this
 * is the same rule at the writing end.
 *
 * The tell is disagreement with the operating system: if the OS offset is not
 * zero while Intl claims UTC, the zone did not resolve. A device really on UTC
 * agrees with itself and is recorded normally.
 *
 * Taken from the documented fallback rather than from an observed failure —
 * `TZ` is not honoured on the Windows machine this was written on, so the
 * unresolved case could not be reproduced locally.
 */
export function usableTimeZone(
  resolved: string | undefined,
  offsetMinutes: number,
): string | undefined {
  if (resolved === undefined || resolved === '') return undefined
  if (resolved === 'UTC' && offsetMinutes !== 0) return undefined
  return resolved
}

/** The zone to stamp on a capture taken now, or undefined to record none. */
export function deviceTimeZone(): string | undefined {
  return usableTimeZone(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    new Date().getTimezoneOffset(),
  )
}
