import { chmod, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * MAIN PROCESS ONLY — this module imports node:fs.
 *
 * `text` in place of whatever is at `path`, whole or not at all (KV-223):
 * written to `<path>.tmp`, flushed to the disk, and only then renamed over the
 * original.
 *
 * The flush is what a power cut asks for. A rename is a change to the folder
 * and the text is a change to the file, and a file system may put the first on
 * disk before the second: without the flush, a machine that lost power just
 * after a write could come back with the new name on a file that is empty or
 * full of zeros — the whole history gone, and an empty one read as a first run
 * with nothing to say so. Flushed first, what the rename names is already
 * there, so the worst a power cut leaves is the file as it was before.
 *
 * The folder is flushed after the rename where a folder can be (`flushFolder`),
 * so a write that was answered stays made. A lost rename is the earlier file,
 * complete — and for a write that took something out, a check-in deleted or a
 * viewer's sharing ended, the earlier file is the one that still holds it.
 * Windows has no flush for a folder to ask for, so there that gap stays.
 *
 * `mode`, where given, is the file's permissions from before a byte is written (KV-226):
 * set on the temporary file as it is opened, and kept by the rename. Set again, not only
 * asked for at creation, because a temporary file a crash left behind is opened as it is.
 * POSIX only: on Windows a mode sets at most the read-only bit, and who may read the file
 * is the folder's to decide.
 *
 * One temporary name for each path, so a caller with more than one writer
 * queues them (as the history, the key and the relay's file each do). A write
 * that fails takes its temporary file with it (review of #247): it holds
 * everything the file would have — a key, every sealed envelope — under a name
 * nothing else reads, removes or expires.
 */
/**
 * Readable and writable by the file's own user, and nobody else (KV-257): the mode for
 * a file holding the history, the household's key, or the relay's state. POSIX only; on
 * Windows a mode sets at most the read-only bit, and who may read a file under a
 * profile is the profile's to decide.
 */
export const OWN_USER_ONLY = 0o600

/**
 * Brings a file a build before KV-257 left as the umask made it — often readable by
 * every user — to `OWN_USER_ONLY`, without waiting for its next write. Asked, never
 * required: a file that is not there is the first run, and one this user cannot change
 * the mode of is no reason to refuse to open it. Its next write replaces it with one
 * that is `OWN_USER_ONLY`.
 */
export async function keepToOwnUser(path: string): Promise<void> {
  await chmod(path, OWN_USER_ONLY).catch(() => undefined)
}

export async function replaceFile(path: string, text: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp`
  try {
    const file = await open(tmp, 'w', mode)
    try {
      if (mode !== undefined) await file.chmod(mode)
      await file.writeFile(text, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
  await flushFolder(dirname(path))
}

/**
 * Flushes a folder, so a rename or a new name in it is on the disk. Asked for,
 * never required: by now the file is in place and whole, and a folder that
 * will not flush leaves the write no worse than a power cut a moment earlier
 * would have. Not asked for on Windows, where a folder cannot be opened to
 * flush.
 */
async function flushFolder(folder: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(folder, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* asked for, not required: see above */
  }
}
