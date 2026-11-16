import { open, rename } from 'node:fs/promises'

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
 * The folder itself is not flushed after the rename. A rename lost that way is
 * the earlier file, complete — one write gone, which is the loss this design
 * already accepts — and Windows has no flush for a folder to ask for.
 *
 * One temporary name for each path, so a caller with more than one writer
 * queues them (as the history, the key and the relay's file each do). The
 * temporary file is left where a failure leaves it; a caller that minds
 * removes it.
 */
export async function replaceFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  const file = await open(tmp, 'w')
  try {
    await file.writeFile(text, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(tmp, path)
}
