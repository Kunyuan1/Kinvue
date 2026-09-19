import { describe, expect, it } from 'vitest'
import {
  createGuidanceGate,
  GUIDANCE_REPEAT_MS,
  GUIDANCE_SETTLE_MS,
} from '../app/main/guidance'

/**
 * These pin what a person is told while sitting in front of the camera, so the
 * cases are the ones from the real captures (KV-1): an opening burst of advice
 * about the camera's own exposure, then the same line thirty times a second.
 */

const START = 1_000_000

describe('createGuidanceGate', () => {
  it('says nothing while the camera is still settling', () => {
    // Six real captures each emitted 57 "increase light" hints at ~4-5s, well
    // lit and badly lit alike. Telling someone to turn on a light every time
    // they check in would teach them to ignore the advice.
    const gate = createGuidanceGate(START)

    expect(gate.offer('Too dark — turn on a light or face a window.', START + 4_500)).toBeNull()
    expect(gate.offer('Too dark — turn on a light or face a window.', START + 5_900)).toBeNull()
  })

  it('speaks once the camera has settled', () => {
    const gate = createGuidanceGate(START)
    const message = 'Sit back a little so your chest is in view.'

    expect(gate.offer(message, START + GUIDANCE_SETTLE_MS)).toBe(message)
  })

  it('does not repeat advice already on screen', () => {
    // The SDK repeats at camera rate; re-sending the same line keeps pulling
    // the reader back to it while they are trying to act on it.
    const gate = createGuidanceGate(START)
    const message = 'Move up, or tilt the camera down.'
    const at = START + GUIDANCE_SETTLE_MS

    expect(gate.offer(message, at)).toBe(message)
    expect(gate.offer(message, at + 33)).toBeNull()
    expect(gate.offer(message, at + GUIDANCE_REPEAT_MS - 1)).toBeNull()
  })

  it('says it again if it is still true a while later', () => {
    const gate = createGuidanceGate(START)
    const message = 'Look straight at the camera.'
    const at = START + GUIDANCE_SETTLE_MS

    expect(gate.offer(message, at)).toBe(message)
    expect(gate.offer(message, at + GUIDANCE_REPEAT_MS)).toBe(message)
  })

  it('passes a change through at once, without waiting', () => {
    // The person moved and the problem is now a different one. Making them
    // wait on a repeat timer would leave the wrong advice in front of them.
    const gate = createGuidanceGate(START)
    const at = START + GUIDANCE_SETTLE_MS

    expect(gate.offer('Sit back a little.', at)).toBe('Sit back a little.')
    expect(gate.offer('Too bright — move away from the light behind you.', at + 100)).toBe(
      'Too bright — move away from the light behind you.',
    )
  })

  it('measures the settle window from this capture, not from the last one', () => {
    const first = createGuidanceGate(START)
    const second = createGuidanceGate(START + 60_000)

    expect(first.offer('Hold still.', START + GUIDANCE_SETTLE_MS)).toBe('Hold still.')
    expect(second.offer('Hold still.', START + 60_000 + 1_000)).toBeNull()
  })
})
