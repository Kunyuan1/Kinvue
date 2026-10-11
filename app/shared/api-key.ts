/**
 * Where the household's SmartSpectra key stands (KV-19), as main reports it and
 * the screens say it. Never the key itself: the page is not given it.
 */
export type KeyStatus =
  /** No key yet: the first-run screen asks for one. */
  | 'none'
  /** Typed, held in memory until the operating system's key is on disk, then sealed. */
  | 'held'
  /** Kept, encrypted with the operating system's key. */
  | 'saved'
  /** Kept unencrypted: this computer has no key store. */
  | 'saved-plain'
  /** A key is kept, and the key store cannot be reached just now: asked again next start. */
  | 'locked'
  /** A key file this account's key would not open: asked for again. */
  | 'lost'
  /** A development build, using `SMARTSPECTRA_API_KEY` from its environment or `.env`. */
  | 'environment'

/**
 * What entering a key came to: kept, with where it stands now, or refused —
 * not a key at all, or the key store out of reach with a saved key it will not
 * replace unseen.
 */
export type SetKeyResult =
  | { ok: true; status: KeyStatus }
  | { ok: false; why: 'not-a-key' | 'locked'; status: KeyStatus }

/** Whether a reading can run with the key as it stands. */
export const keyReady = (status: KeyStatus | undefined): boolean =>
  status === 'held' || status === 'saved' || status === 'saved-plain' || status === 'environment'
