import { describe, expect, it } from 'vitest'
import {
  createGuidanceGate,
  GUIDANCE_PERSIST_MS,
  GUIDANCE_REPEAT_MS,
  SETTLING_PERSIST_MS,
  type CaptureGuidance,
} from '@core/capture/guidance'

/**
 * These pin what a person reads while sitting in front of the camera, so the
 * cases are the ones the real captures produced (KV-1): a burst of exposure
 * complaints while the camera settles, then the same code thirty times a
 * second, and — when someone is between two framing problems — two codes
 * alternating at that rate.
 */

const framing = (message: string): CaptureGuidance => ({ message, settlingArtefact: false })
const exposure = (message: string): CaptureGuidance => ({ message, settlingArtefact: true })

const TOO_DARK = exposure('Too dark — turn on a light or face a window.')
const SIT_BACK = framing('Sit back a little so your chest is in view.')
const CENTRE = framing('Move to the centre of the picture.')
const CLOSER = framing('Come a little closer.')

/** The stream arrives at roughly 30 Hz; these walk it at that rate. */
const frames = (gate: ReturnType<typeof createGuidanceGate>, advice: CaptureGuidance | null,
  from: number, toExclusive: number): (ReturnType<typeof gate.offer>)[] => {
  const seen = []
  for (let t = from; t < toExclusive; t += 33) seen.push(gate.offer(advice, t))
  return seen
}

describe('createGuidanceGate', () => {
  it('does not pass on the exposure burst a settling camera produces', () => {
    // Six captures each emitted about a second of "too dark" while exposure
    // settled, well lit and badly lit alike. Saying it would open every
    // check-in with advice the person cannot act on.
    const gate = createGuidanceGate()
    const shown = frames(gate, TOO_DARK, 0, 1_000).filter((u) => u !== null)

    expect(shown).toEqual([])
  })

  it('does say it when the room really is too dark', () => {
    // Held well past the burst, it stops being an artefact and starts being true.
    const gate = createGuidanceGate()
    frames(gate, TOO_DARK, 0, SETTLING_PERSIST_MS)

    expect(gate.offer(TOO_DARK, SETTLING_PERSIST_MS)).toEqual({ show: TOO_DARK.message })
  })

  it('passes framing advice through without waiting on the camera', () => {
    // A face out of frame is never a warm-up artefact, and it is the most
    // actionable line in the table — waiting seconds would eat the capture.
    const gate = createGuidanceGate()
    frames(gate, SIT_BACK, 0, GUIDANCE_PERSIST_MS)

    expect(gate.offer(SIT_BACK, GUIDANCE_PERSIST_MS)).toEqual({ show: SIT_BACK.message })
  })

  it('says nothing while advice is too new to trust', () => {
    const gate = createGuidanceGate()

    expect(gate.offer(SIT_BACK, 0)).toBeNull()
    expect(gate.offer(SIT_BACK, GUIDANCE_PERSIST_MS - 1)).toBeNull()
  })

  it('stays silent when two problems alternate at camera rate', () => {
    // Someone slightly off-centre and slightly too far makes the SDK flip
    // between codes. Every flip is a change, so a gate that only throttled
    // repeats would swap the instruction dozens of times a second.
    const gate = createGuidanceGate()
    const shown = []
    for (let t = 0; t < 3_000; t += 33) {
      const update = gate.offer(t % 66 === 0 ? CENTRE : CLOSER, t)
      if (update !== null) shown.push(update)
    }

    expect(shown).toEqual([])
  })

  it('does not repeat a line the person is already reading', () => {
    const gate = createGuidanceGate()
    frames(gate, SIT_BACK, 0, GUIDANCE_PERSIST_MS)
    const at = GUIDANCE_PERSIST_MS

    expect(gate.offer(SIT_BACK, at)).toEqual({ show: SIT_BACK.message })
    expect(gate.offer(SIT_BACK, at + 33)).toBeNull()
    expect(gate.offer(SIT_BACK, at + GUIDANCE_REPEAT_MS - 1)).toBeNull()
  })

  it('says it again once it has gone stale and is still true', () => {
    const gate = createGuidanceGate()
    frames(gate, SIT_BACK, 0, GUIDANCE_PERSIST_MS)
    const at = GUIDANCE_PERSIST_MS
    gate.offer(SIT_BACK, at)

    expect(gate.offer(SIT_BACK, at + GUIDANCE_REPEAT_MS)).toEqual({ show: SIT_BACK.message })
  })

  it('clears the instruction once the person has fixed it', () => {
    // Someone told to sit back, who sits back, must not still be reading
    // "sit back" for the rest of the capture.
    const gate = createGuidanceGate()
    frames(gate, SIT_BACK, 0, GUIDANCE_PERSIST_MS)
    gate.offer(SIT_BACK, GUIDANCE_PERSIST_MS)

    const at = GUIDANCE_PERSIST_MS + 1_000
    frames(gate, null, at, at + GUIDANCE_PERSIST_MS)
    expect(gate.offer(null, at + GUIDANCE_PERSIST_MS)).toEqual({ clear: true })
  })

  it('does not blink the instruction away on one good frame', () => {
    const gate = createGuidanceGate()
    frames(gate, SIT_BACK, 0, GUIDANCE_PERSIST_MS)
    gate.offer(SIT_BACK, GUIDANCE_PERSIST_MS)

    expect(gate.offer(null, GUIDANCE_PERSIST_MS + 33)).toBeNull()
  })

  it('clears nothing when nothing is on screen', () => {
    const gate = createGuidanceGate()

    expect(gate.offer(null, 0)).toBeNull()
    expect(gate.offer(null, 10_000)).toBeNull()
  })

  it('replaces one instruction with another once the new one holds', () => {
    const gate = createGuidanceGate()
    frames(gate, SIT_BACK, 0, GUIDANCE_PERSIST_MS)
    gate.offer(SIT_BACK, GUIDANCE_PERSIST_MS)

    const at = GUIDANCE_PERSIST_MS + 500
    frames(gate, CLOSER, at, at + GUIDANCE_PERSIST_MS)
    expect(gate.offer(CLOSER, at + GUIDANCE_PERSIST_MS)).toEqual({ show: CLOSER.message })
  })
})
