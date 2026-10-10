/**
 * Whether Windows lets Kinvue use the camera at all (KV-19), as main reads it
 * and the setup screen says it. Here, not in `app/main`, so the preload and the
 * renderer name it without reaching into main — which lint refuses.
 */
export type CameraAccess =
  | 'allowed'
  /** Settings › Privacy & security › Camera › *Camera access*: the whole computer. */
  | 'off-for-this-computer'
  /** *Let apps access your camera*: every app for this account. */
  | 'off-for-apps'
  /** *Let desktop apps access your camera*: what Kinvue is. */
  | 'off-for-desktop-apps'
  /**
   * Kinvue itself, by its own path: no switch in Settings, but set by policy
   * or a computer's maker, and as final as the others (review of #193).
   */
  | 'off-for-kinvue'
  /** Not Windows, or the switches could not be read: nothing to say. */
  | 'unknown'
