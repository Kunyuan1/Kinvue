import type { RestoreResult } from '@core/session/lifecycle'
import { unprotect, type ProtectedExport, type Unprotected } from '@core/session/protect'

/**
 * A protected export waiting in main for its passphrase (KV-175), and the tries
 * at it. Held here, so the renderer is never handed the file. Its own module,
 * free of Electron, so the rules below are tested in plain node (review of
 * #187), with the page given as the two events it needs.
 */

/** The parts of the page's `WebContents` this listens to. */
export interface PageEvents {
  on(event: 'did-navigate', listener: () => void): unknown
  on(event: 'destroyed', listener: () => void): unknown
  off(event: 'did-navigate', listener: () => void): unknown
  off(event: 'destroyed', listener: () => void): unknown
}

interface Held {
  personId: string
  file: ProtectedExport
  page: PageEvents
  drop: () => void
}

export interface ProtectedRestores {
  /** Holds `file` for `personId` until it is restored, cancelled, or the page goes. */
  hold(page: PageEvents, personId: string, file: ProtectedExport): void
  /** Lets go of whatever is held: Cancel, or another restore starting. */
  letGo(): void
  /** Whether a file is held — for the tests. */
  holding(): boolean
  /**
   * Opens the held file with `passphrase` and hands what it holds to
   * `restore`. A wrong passphrase keeps the file for another try.
   */
  unlock(
    personId: string,
    passphrase: string,
    restore: (contents: unknown) => Promise<RestoreResult>,
  ): Promise<RestoreResult>
}

export function protectedRestores(
  open: (file: ProtectedExport, passphrase: string) => Promise<Unprotected> = unprotect,
): ProtectedRestores {
  let held: Held | null = null
  // Tries one at a time (review of #187): each is about a second of scrypt and
  // 128 MiB, and a renderer — compromised, T8 — sending many at once would
  // otherwise run them all together, against main's memory.
  let queue: Promise<unknown> = Promise.resolve()

  const letGo = (): void => {
    if (held === null) return
    const { page, drop } = held
    held = null
    page.off('did-navigate', drop)
    page.off('destroyed', drop)
  }

  return {
    hold(page, personId, file) {
      letGo()
      // Not for the rest of the process's life (review of #187): a page that
      // reloads or closes has lost its passphrase field and its Cancel, so the
      // file it was asked for goes with them.
      const drop = (): void => letGo()
      page.on('did-navigate', drop)
      page.on('destroyed', drop)
      held = { personId, file, page, drop }
    },
    letGo,
    holding: () => held !== null,
    unlock(personId, passphrase, restore) {
      const work = async (): Promise<RestoreResult> => {
        // Asked once its turn comes: a try queued behind one that restored
        // finds nothing held, and says so.
        const mine = held
        if (mine === null || mine.personId !== personId) {
          throw new Error('history:restoreProtected has no protected file waiting.')
        }
        const opened = await open(mine.file, passphrase)
        // Cancelled, or the page gone, while scrypt ran (review of #187): a
        // Cancel that was accepted is not followed by a restore.
        if (held !== mine) {
          throw new Error('history:restoreProtected was cancelled while it was opening the file.')
        }
        if (!opened.ok) {
          if (opened.why === 'wrong-passphrase') {
            return { ok: false, refusal: { kind: 'wrong-passphrase' } }
          }
          letGo()
          return { ok: false, refusal: { kind: 'unreadable', why: opened.detail } }
        }
        letGo()
        return await restore(opened.contents)
      }
      const run = queue.then(work, work)
      queue = run.catch(() => undefined)
      return run
    },
  }
}
