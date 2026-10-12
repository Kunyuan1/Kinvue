/**
 * One pass of main's seal loop (KV-175, KV-19): the household's key, and the
 * history, sealed once the operating system's key is on disk. Its own module,
 * free of Electron, so the order and the failures are tested in plain node.
 *
 * The two are separate failures (review of #195). A history that cannot be
 * read — corrupt, or held open by another program — fails its seal on every
 * pass, and must not keep a key typed into the first-run screen from being
 * sealed: that key is only in memory, and is lost when the app closes. So the
 * key goes first, each in its own try, and a failure names which.
 */
export interface SealSteps {
  /** Whether the operating system's key is on disk. Nothing is sealed before. */
  keyLanded(): Promise<boolean>
  /** Seals a key held in memory; true when nothing of the key is left to seal. */
  sealKey(): Promise<boolean>
  /** Seals a plain history; throws when it cannot. */
  sealHistory(): Promise<unknown>
  /** Whether the history on disk is still plain after trying. */
  historyPlain(): Promise<boolean>
  /** Said once per kind, so a failure retried every pass is not a log flood. */
  failed(what: 'key' | 'history', err: unknown): void
}

/** One pass: true when both are sealed, or hold nothing to seal. */
export async function settleOnce(steps: SealSteps): Promise<boolean> {
  if (!(await steps.keyLanded())) return false
  let keyDone = false
  try {
    keyDone = await steps.sealKey()
  } catch (err) {
    steps.failed('key', err)
  }
  try {
    await steps.sealHistory()
  } catch (err) {
    steps.failed('history', err)
  }
  return keyDone && !(await steps.historyPlain())
}
