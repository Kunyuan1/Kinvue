/**
 * Turning the SDK's processed frames into something a screen can show.
 *
 * The person being measured cannot see what the camera sees, and KV-1 showed
 * what that costs: two real captures returned no readings at all because a face
 * sat at the bottom of the frame and nobody could tell. The SDK holds the
 * webcam exclusively, so nothing else can show them either — the frames have to
 * come from here.
 *
 * **Display only.** Nothing writes footage to disk, and the README's "no raw
 * video is stored or transmitted" claim depends on that staying true. A frame
 * lives as long as it takes to draw it.
 *
 * Imports nothing, so the conversion is tested without a camera or Electron.
 */

/** One frame as the SDK hands it over. */
export interface SdkFrame {
  data: Uint8Array
  width: number
  height: number
  /** Bytes per row, which is not always `width * channels`. */
  stride: number
  /** `PixelFormat` from the SDK: 0 kRGB, 1 kBGR, 2 kRGBA, 3 kBGRA. */
  pixelFormat: number
}

const RGB = 0
const BGR = 1
const RGBA = 2
const BGRA = 3

/**
 * How often a frame is sent to the renderer. The camera produces around 30 a
 * second; a self-view exists to show someone their own framing, which ten a
 * second does as well as thirty while asking a great deal less of the IPC
 * bridge that also carries the check-in.
 */
export const FRAME_INTERVAL_MS = 100

/** The width frames are sampled down to. Enough to see your own framing by. */
export const FRAME_WIDTH = 320

/** A frame converted for display: tightly packed BGRA at the size given. */
export interface Preview {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Converts to the tightly packed BGRA that Electron's `nativeImage` wants,
 * sampling down to `targetWidth` as it goes, or null for a format this does
 * not handle.
 *
 * **Scaled during the conversion, not after it.** This runs on the same event
 * loop that services the SDK's callbacks, the guidance gate and all IPC,
 * during the thirty seconds when guidance latency is the point of the screen.
 * Converting a 1280×720 frame in full would be a ~920,000-iteration loop
 * writing 3.7 MB, ten times a second, before a native resize threw most of it
 * away. Sampling straight to 320px reads one source pixel per output pixel
 * instead — nearest-neighbour, which is what a self-view needs: it is there to
 * show someone where they are in the frame, not to be looked at closely.
 *
 * Packed YUV formats (NV12, NV21, YUYV) are deliberately not converted: the
 * arithmetic is real work, no run has produced one, and a self-view is a help
 * rather than a requirement. Returning null costs the person their preview and
 * nothing else — the capture carries on, and the guidance text still tells them
 * what to fix. The screen is told, so it can say so rather than sit blank.
 */
export function toPreview(frame: SdkFrame, targetWidth: number = FRAME_WIDTH): Preview | null {
  const { data, width, height, stride, pixelFormat } = frame
  if (pixelFormat !== RGB && pixelFormat !== BGR && pixelFormat !== RGBA && pixelFormat !== BGRA) {
    return null
  }
  if (width <= 0 || height <= 0 || targetWidth <= 0) return null

  const channels = pixelFormat === RGBA || pixelFormat === BGRA ? 4 : 3
  if (stride < width * channels) return null
  // The last row is only read as far as its pixels go, so a buffer that pads
  // between rows but not after the final one is still complete. Requiring a
  // full stride for that row would decline every frame from such a backend and
  // take the self-view with it.
  if (data.length < stride * (height - 1) + width * channels) return null

  const outWidth = Math.min(width, targetWidth)
  const outHeight = Math.max(1, Math.round((height * outWidth) / width))
  const redFirst = pixelFormat === RGB || pixelFormat === RGBA
  const out = new Uint8Array(outWidth * outHeight * 4)

  for (let y = 0; y < outHeight; y++) {
    const sourceRow = Math.min(height - 1, Math.floor((y * height) / outHeight)) * stride
    const target = y * outWidth * 4
    for (let x = 0; x < outWidth; x++) {
      const from = sourceRow + Math.min(width - 1, Math.floor((x * width) / outWidth)) * channels
      const to = target + x * 4
      const first = data[from] as number
      const second = data[from + 1] as number
      const third = data[from + 2] as number
      out[to] = redFirst ? third : first
      out[to + 1] = second
      out[to + 2] = redFirst ? first : third
      out[to + 3] = 255
    }
  }
  return { data: out, width: outWidth, height: outHeight }
}

/** Returns true when enough time has passed to send another frame. */
export function createFrameThrottle(
  intervalMs: number = FRAME_INTERVAL_MS,
): (atMs: number) => boolean {
  let lastSentAt: number | undefined

  return (atMs) => {
    if (lastSentAt !== undefined && atMs - lastSentAt < intervalMs) return false
    lastSentAt = atMs
    return true
  }
}
