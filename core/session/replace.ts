import { chmod, open, rename, rm, unlink } from 'node:fs/promises'
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
export async function replaceFile(path: string, text: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp`
  try {
    const file = await open(tmp, 'w', mode)
    try {
      if (mode !== undefined) await setMode(file, mode)
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
 * Readable and writable by the file's own user, and nobody else (KV-257): the mode for
 * the history, the household's key, and the relay's state alike. POSIX only; on Windows
 * a mode sets at most the read-only bit, and who may read a file under a profile is the
 * profile's to decide.
 */
export const OWN_USER_ONLY = 0o600

/**
 * The errors that mean a file system keeps no such mode — FAT and exFAT on Linux under
 * their default mount, some network shares — rather than that something went wrong.
 */
const NO_MODES_HERE = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP'])

/**
 * `mode` on an open file, where the file system keeps one (review of #258). Where it
 * keeps none, a write goes ahead without it: the mode a new file was opened with is
 * already all such a file system will hold, and a history on a USB stick that refused
 * every check-in for a mode it cannot keep would be the wrong way round. Anything else
 * is a failure, and fails the write.
 */
export async function setMode(
  file: { chmod: (mode: number) => Promise<void> },
  mode: number,
): Promise<void> {
  try {
    await file.chmod(mode)
  } catch (err) {
    if (!NO_MODES_HERE.has((err as NodeJS.ErrnoException).code ?? '')) throw err
  }
}

/**
 * What a build before KV-226 or KV-257 may have left readable by every user, made its
 * own user's now rather than at the next write, which may be days away or never.
 * The one policy for the relay, the history and the key alike (review of #258).
 *
 * - **A temporary file a crash left** holds the whole file — the history, a key, every
 *   sealed envelope — under a name nothing reads, expires or removes. Each caller is the
 *   one process writing `path` (KV-222, the relay's lock), and runs this before its
 *   first write, so nothing is writing it: it is removed.
 * - **The file** is brought to `OWN_USER_ONLY`.
 *
 * Asked, never required: a file not there is the first run, and one this user may read
 * but not change the mode of — owned by another account, restored as root — is no
 * reason to refuse to open it; its next write replaces it with one of its own. That is
 * returned, in words, for the caller to say where it says things; null when there is
 * nothing to say.
 */
export async function keepToOwnUser(path: string): Promise<string | null> {
  await rm(`${path}.tmp`, { force: true }).catch(() => undefined)
  try {
    await chmod(path, OWN_USER_ONLY)
    return null
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException
    if (code === 'ENOENT') return null
    return (
      `Could not make ${path} readable by this user only (${code ?? message}). It is ` +
      'replaced by a file of its own at its next write; until then, check who can read it.'
    )
  }
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
