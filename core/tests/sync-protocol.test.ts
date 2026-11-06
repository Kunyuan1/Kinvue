import { describe, expect, it } from 'vitest'
import {
  checkAck,
  checkPostEnvelopes,
  DELIVERY_RETENTION_MS,
  ENDED,
  ENVELOPE_RETENTION_MS,
  isKey,
  isNonce,
  isSignature,
  MAX_SEALED_CHARS,
  requestBytes,
  REQUEST_WINDOW_MS,
} from '@kinvue/core/sync/protocol'

const KEY = 'A'.repeat(43)
const DAY = 24 * 60 * 60 * 1000

describe('what KV-33 and KV-31 fixed, as the protocol holds it (KV-39)', () => {
  it('keeps an envelope 14 days and a fetch 30', () => {
    // KV-33: ciphertext until fetched, at most 14 days; delivery records for #31's 30.
    expect(ENVELOPE_RETENTION_MS).toBe(14 * DAY)
    expect(DELIVERY_RETENTION_MS).toBe(30 * DAY)
  })

  it('accepts a request within five minutes of the relay clock', () => {
    expect(REQUEST_WINDOW_MS).toBe(5 * 60 * 1000)
  })

  it('tells an ended viewer that sharing ended, and nothing else', () => {
    // KV-31: no date, no reason, no prompt to ask.
    expect(ENDED).toEqual({ status: 'ended' })
  })
})

describe('the bytes a request is signed over', () => {
  const request = { method: 'post', path: '/v1/ack', at: 1, nonce: 'n'.repeat(16), bodyHash: 'h' }

  it('names the protocol and every field, one per line', () => {
    expect(requestBytes(request).split('\n')).toEqual([
      'kinvue-relay/1',
      'POST',
      '/v1/ack',
      '1',
      'n'.repeat(16),
      'h',
    ])
  })

  it.each([
    ['method', { method: 'GET' }],
    ['path', { path: '/v1/envelopes' }],
    ['time', { at: 2 }],
    ['nonce', { nonce: 'm'.repeat(16) }],
    ['body', { bodyHash: 'g' }],
  ])('differ when the %s does, so a signature cannot be moved', (_what, change) => {
    expect(requestBytes({ ...request, ...change })).not.toBe(requestBytes(request))
  })
})

describe('keys, nonces and signatures', () => {
  it('reads a key as 32 bytes of base64url', () => {
    expect(isKey(KEY)).toBe(true)
    expect(isKey('A'.repeat(42))).toBe(false)
    expect(isKey('A'.repeat(42) + '=')).toBe(false)
    expect(isKey(`${'A'.repeat(42)}+`)).toBe(false)
    expect(isKey(null)).toBe(false)
  })

  it('reads a nonce as 16 to 64 characters', () => {
    expect(isNonce('a'.repeat(15))).toBe(false)
    expect(isNonce('a'.repeat(16))).toBe(true)
    expect(isNonce('a'.repeat(64))).toBe(true)
    expect(isNonce('a'.repeat(65))).toBe(false)
  })

  it('reads a signature as 64 bytes of base64url', () => {
    expect(isSignature('a'.repeat(86))).toBe(true)
    expect(isSignature('a'.repeat(85))).toBe(false)
  })
})

describe('checkPostEnvelopes', () => {
  const envelope = { viewer: KEY, stream: 1, sealed: 'abc_-' }

  it('passes envelopes for viewers', () => {
    expect(checkPostEnvelopes({ envelopes: [envelope] })).toBeNull()
  })

  it.each([
    ['no list', {}, 'envelopes: not a list'],
    ['an empty list', { envelopes: [] }, 'envelopes: empty'],
    ['a viewer that is not a key', { envelopes: [{ ...envelope, viewer: 'x' }] }, 'viewer'],
    ['stream 0', { envelopes: [{ ...envelope, stream: 0 }] }, 'stream'],
    ['a fractional stream', { envelopes: [{ ...envelope, stream: 1.5 }] }, 'stream'],
    ['a stream as text', { envelopes: [{ ...envelope, stream: '1' }] }, 'stream'],
    ['an empty seal', { envelopes: [{ ...envelope, sealed: '' }] }, 'sealed'],
    ['a seal that is not base64url', { envelopes: [{ ...envelope, sealed: 'a+b' }] }, 'sealed'],
    [
      'a seal too long',
      { envelopes: [{ ...envelope, sealed: 'a'.repeat(MAX_SEALED_CHARS + 1) }] },
      'longer',
    ],
  ])('refuses %s', (_what, body, says) => {
    expect(checkPostEnvelopes(body)).toContain(says)
  })
})

describe('checkAck', () => {
  it('passes a stream number', () => {
    expect(checkAck({ through: 3 })).toBeNull()
  })

  it.each([[{}], [{ through: 0 }], [{ through: -1 }], [null], [[]]])('refuses %j', (body) => {
    expect(checkAck(body)).not.toBeNull()
  })
})
