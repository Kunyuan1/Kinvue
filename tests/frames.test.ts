import { describe, expect, it } from 'vitest'
import { createFrameThrottle, toPreview, type SdkFrame } from '../app/main/frames'

/**
 * The self-view is what KV-1 showed a capture needs: two real captures returned
 * nothing because a face sat at the bottom of the frame and the person could
 * not see it. These cover the conversion that puts those frames on a screen —
 * channel order, row padding, and the formats it declines rather than mangles.
 */

const frame = (over: Partial<SdkFrame> & Pick<SdkFrame, 'data'>): SdkFrame => ({
  width: 2,
  height: 1,
  stride: 6,
  pixelFormat: 0,
  ...over,
})

describe('toPreview', () => {
  it('reorders RGB into BGRA and fills the alpha', () => {
    const red = 10
    const green = 20
    const blue = 30
    const out = toPreview(frame({ data: Uint8Array.from([red, green, blue, 1, 2, 3]) }), 2)

    expect(out?.data.slice(0, 4)).toEqual(Uint8Array.from([blue, green, red, 255]))
  })

  it('keeps BGR in the order it arrived', () => {
    const out = toPreview(frame({ pixelFormat: 1, data: Uint8Array.from([30, 20, 10, 3, 2, 1]) }), 2)

    expect(out?.data.slice(0, 4)).toEqual(Uint8Array.from([30, 20, 10, 255]))
  })

  it('reads four-channel formats without shifting the pixels', () => {
    const rgba = toPreview(
      frame({ pixelFormat: 2, stride: 8, data: Uint8Array.from([10, 20, 30, 40, 1, 2, 3, 4]) }),
      2,
    )
    const bgra = toPreview(
      frame({ pixelFormat: 3, stride: 8, data: Uint8Array.from([30, 20, 10, 40, 3, 2, 1, 4]) }),
      2,
    )

    expect(rgba?.data.slice(0, 4)).toEqual(Uint8Array.from([30, 20, 10, 255]))
    expect(bgra?.data.slice(0, 4)).toEqual(Uint8Array.from([30, 20, 10, 255]))
  })

  it('skips the padding at the end of each row', () => {
    // A stride wider than the row is normal, and reading straight through it
    // would skew every row after the first — a picture sheared diagonally.
    const data = Uint8Array.from([
      1, 2, 3, 0, 0, 0, // row 0: one pixel, then padding
      7, 8, 9, 0, 0, 0, // row 1
    ])
    const out = toPreview({ data, width: 1, height: 2, stride: 6, pixelFormat: 0 }, 1)

    expect(out?.data).toEqual(Uint8Array.from([3, 2, 1, 255, 9, 8, 7, 255]))
  })

  it('declines a packed YUV frame rather than mangling it', () => {
    // No run has produced one. The capture carries on without a preview, and
    // the guidance text still says what to fix.
    expect(toPreview(frame({ pixelFormat: 4, data: Uint8Array.from([0, 0, 0, 0, 0, 0]) }))).toBeNull()
  })

  it('declines a frame whose buffer is shorter than it claims', () => {
    expect(
      toPreview({ data: Uint8Array.from([1, 2, 3]), width: 4, height: 4, stride: 12, pixelFormat: 0 }),
    ).toBeNull()
    expect(toPreview(frame({ stride: 2, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) }))).toBeNull()
    expect(toPreview(frame({ width: 0, data: Uint8Array.from([]) }))).toBeNull()
  })

  it('accepts a buffer that pads between rows but not after the last one', () => {
    // Requiring a full stride for the final row declines every frame from a
    // backend that packs it tightly — and takes the whole self-view with it.
    const data = Uint8Array.from([
      1, 2, 3, 0, 0, 0, // row 0: one pixel, then padding
      7, 8, 9, // row 1: no trailing padding
    ])
    const out = toPreview({ data, width: 1, height: 2, stride: 6, pixelFormat: 0 }, 1)

    expect(out?.data).toEqual(Uint8Array.from([3, 2, 1, 255, 9, 8, 7, 255]))
  })

  it('samples down to the width asked for, keeping the aspect ratio', () => {
    // Scaled during the conversion rather than after it: converting a full
    // 1280x720 frame ten times a second, on the loop that also carries the
    // guidance, is most of the work and all of it thrown away by a resize.
    const width = 8
    const height = 4
    const data = new Uint8Array(width * height * 3)
    for (let i = 0; i < width * height; i++) data[i * 3] = i // red channel counts pixels
    const out = toPreview({ data, width, height, stride: width * 3, pixelFormat: 0 }, 4)

    expect(out?.width).toBe(4)
    expect(out?.height).toBe(2)
    expect(out?.data.length).toBe(4 * 2 * 4)
  })

  it('never scales a frame up', () => {
    const out = toPreview(frame({ data: Uint8Array.from([1, 2, 3, 4, 5, 6]) }), 640)

    expect(out?.width).toBe(2)
  })
})

describe('createFrameThrottle', () => {
  it('passes the first frame straight through', () => {
    expect(createFrameThrottle(100)(0)).toBe(true)
  })

  it('drops frames arriving faster than the interval', () => {
    // The camera produces about 30 a second; ten shows framing just as well
    // and asks far less of the bridge that also carries the check-in.
    const send = createFrameThrottle(100)

    expect(send(0)).toBe(true)
    expect(send(33)).toBe(false)
    expect(send(66)).toBe(false)
    expect(send(100)).toBe(true)
  })

  it('measures from the frame it last sent, not from the last offered', () => {
    const send = createFrameThrottle(100)

    expect(send(0)).toBe(true)
    expect(send(90)).toBe(false)
    expect(send(150)).toBe(true)
    expect(send(200)).toBe(false)
  })
})
