import { execFile } from 'node:child_process'
import type { CameraAccess } from '../shared/camera-access'

export type { CameraAccess }

/**
 * Whether Windows lets Kinvue use the camera at all (KV-19), checked before
 * anyone sits down to a capture rather than after one fails.
 *
 * A Windows desktop app cannot raise the camera prompt; three privacy switches
 * decide, and the SDK — which opens the camera in native code, not through
 * Chromium — is simply refused when one is off. Read from where Windows keeps
 * them, each `Allow` or `Deny`; a switch never set is `Allow`. Off any of them
 * is said by name, with where to turn it on. The answers are `CameraAccess`,
 * in `app/shared/`.
 */

const STORE = String.raw`Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam`

/** The three switches, widest first, so the one named is the one to change first. */
export const SWITCHES = [
  { key: 'HKLM\\' + STORE, off: 'off-for-this-computer' },
  { key: 'HKCU\\' + STORE, off: 'off-for-apps' },
  { key: 'HKCU\\' + STORE + '\\NonPackaged', off: 'off-for-desktop-apps' },
] as const

/** A switch's value: `Allow`, `Deny`, or null when it was never set. Throws when it cannot be read. */
export type ReadSwitch = (key: string) => Promise<string | null>

/** What the switches say, read with `read`. */
export async function cameraAccess(read: ReadSwitch): Promise<CameraAccess> {
  try {
    for (const { key, off } of SWITCHES) {
      if ((await read(key)) === 'Deny') return off
    }
    return 'allowed'
  } catch {
    return 'unknown'
  }
}

/** The `Value` in what `reg.exe query` printed, or null when it holds none. */
export function valueFrom(regOutput: string): string | null {
  const line = /^\s*Value\s+REG_SZ\s+(\S+)\s*$/m.exec(regOutput)
  return line === null ? null : line[1]!
}

/**
 * The real switches, through `reg.exe` — Windows's own, by its full path rather
 * than whatever `reg` comes first on `PATH`. A missing key or value is "never
 * set".
 */
export const readWindowsSwitch: ReadSwitch = (key) =>
  new Promise((resolve, reject) => {
    const reg = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\reg.exe`
    execFile(reg, ['query', key, '/v', 'Value'], { windowsHide: true }, (err, stdout) => {
      // reg exits 1 for a key or value that does not exist: never set.
      if (err !== null && (err as { code?: unknown }).code === 1) resolve(null)
      else if (err !== null) reject(err)
      else resolve(valueFrom(stdout))
    })
  })
