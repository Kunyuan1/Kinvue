// The one place app/main reaches `shell`; lint refuses it everywhere else.
// eslint-disable-next-line no-restricted-syntax
import { shell } from 'electron'

/**
 * Every address Kinvue opens outside itself (Electron's checklist item 15).
 *
 * A fixed list, named, never an address the page sends: `openExternal` hands
 * its argument to the operating system, which runs whatever is registered for
 * it, so a renderer that could choose the address could choose the program. A
 * lint rule keeps `shell` and `openExternal` out of the rest of `app/main`, so
 * a new link out has to be added here, where this is read (review of #193).
 */
export const LINKS = {
  /** Windows's camera privacy page, where the switches the setup screen names are. */
  cameraSettings: 'ms-settings:privacy-webcam',
} as const

export type Link = keyof typeof LINKS

/** Opens `link` from the fixed list above. */
export function openLink(link: Link): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- the one call, from the list above
  return shell.openExternal(LINKS[link])
}
