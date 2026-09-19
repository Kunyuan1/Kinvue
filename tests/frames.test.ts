import { describe, expect, it } from 'vitest'
import { createFrameThrottle, toBgra, type SdkFrame } from '../app/main/frames'

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

describe('toBgra', () => {
  it('reorders RGB into BGRA and fills the alpha', () => {
    const red = 10
    const green = 20
    const blue = 30
    const out = toBgra(frame({ data: Uint8Array.from([red, green, blue, 1, 2, 3]) }))

    expect(out?.slice(0, 4)).toEqual(Uint8Array.from([blue, green, red, 255]))
  })

  it('keeps BGR in the order it arrived', () => {
    const out = toBgra(frame({ pixelFormat: 1, data: Uint8Array.from([30, 20, 10, 3, 2, 1]) }))

    expect(out?.slice(0, 4)).toEqual(Uint8Array.from([30, 20, 10, 255]))
  })

  it('reads four-channel formats without shifting the pixels', () => {
    const rgba = toBgra(
      frame({ pixelFormat: 2, stride: 8, data: Uint8Array.from([10, 20, 30, 40, 1, 2, 3, 4]) }),
    )
    const bgra = toBgra(
      frame({ pixelFormat: 3, stride: 8, data: Uint8Array.from([30, 20, 10, 40, 3, 2, 1, 4]) }),
    )

    expect(rgba?.slice(0, 4)).toEqual(Uint8Array.from([30, 20, 10, 255]))
    expect(bgra?.slice(0, 4)).toEqual(Uint8Array.from([30, 20, 10, 255]))
  })

  it('skips the padding at the end of each row', () => {
    // A stride wider than the row is normal, and reading straight through it
    // would skew every row after the first — a picture sheared diagonally.
    const data = Uint8Array.from([
      1, 2, 3, 0, 0, 0, // row 0: one pixel, then padding
      7, 8, 9, 0, 0, 0, // row 1
    ])
    const out = toBgra({ data, width: 1, height: 2, stride: 6, pixelFormat: 0 })

    expect(out).toEqual(Uint8Array.from([3, 2, 1, 255, 9, 8, 7, 255]))
  })

  it('declines a packed YUV frame rather than mangling it', () => {
    // No run has produced one. The capture carries on without a preview, and
    // the guidance text still says what to fix.
    expect(toBgra(frame({ pixelFormat: 4, data: Uint8Array.from([0, 0, 0, 0, 0, 0]) }))).toBeNull()
  })

  it('declines a frame whose buffer is shorter than it claims', () => {
    expect(toBgra({ data: Uint8Array.from([1, 2, 3]), width: 4, height: 4, stride: 12, pixelFormat: 0 }))
      .toBeNull()
    expect(toBgra(frame({ stride: 2, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) }))).toBeNull()
    expect(toBgra(frame({ width: 0, data: Uint8Array.from([]) }))).toBeNull()
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
