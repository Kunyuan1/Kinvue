/**
 * Where the history's protection stands (KV-175), as main reports it and the
 * dashboard says it. A statement about `sessions.json` on disk, not about the
 * key store (review of #187): the key can be ready while the file is still
 * plain, and the line must never say "encrypted" over a file that is not.
 *
 * Here, not in `app/main`, so the preload and the renderer name it without
 * reaching into a module that loads `node:fs` — which lint now refuses.
 */
export type Protection =
  /** The file on disk is sealed, or holds nothing yet and the next write will be. */
  | 'encrypted'
  /** There is a key store, and the file is still plain: the seal has not landed yet. */
  | 'not-yet-encrypted'
  /** No key store here, and the file is plain. */
  | 'no-key-store'
