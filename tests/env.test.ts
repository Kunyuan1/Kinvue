import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDotEnv } from '../app/main/env'

/**
 * `app/main/env.ts` is main-process code, but it imports nothing from Electron,
 * so the one thing worth pinning — what wins, and what is not an error — runs in
 * the same plain node suite as core/.
 */

const KEY = 'KV51_TEST_KEY'
const OTHER = 'KV51_TEST_OTHER'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinvue-env-'))
  delete process.env[KEY]
  delete process.env[OTHER]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  // In afterEach, not in the test body: a failed assertion would otherwise
  // leak these into the worker for every later file sharing the process.
  delete process.env[KEY]
  delete process.env[OTHER]
})

const envFile = (contents: string): string => {
  const path = join(dir, '.env')
  writeFileSync(path, contents)
  return path
}

describe('loadDotEnv', () => {
  it('reads variables out of the file', () => {
    expect(loadDotEnv(envFile(`${KEY}=from-file\n`))).toBe(true)
    expect(process.env[KEY]).toBe('from-file')
  })

  it('treats a missing file as the normal case, not an error', () => {
    expect(loadDotEnv(join(dir, 'nothing-here'))).toBe(false)
    expect(process.env[KEY]).toBeUndefined()
  })

  it('throws when the path is not a readable file', () => {
    // Anything but ENOENT propagates: the app reports it at startup rather
    // than letting it resurface later as a missing key. A directory is the
    // one non-ENOENT failure that reproduces on every platform.
    expect(() => loadDotEnv(dir)).toThrow()
  })

  it('lets a variable already in the environment win over the file', () => {
    // Node's own precedence, not ours — pinned because the app depends on it:
    // a key exported in the shell must not be overridden by a stale .env.
    process.env[KEY] = 'from-shell'
    loadDotEnv(envFile(`${KEY}=from-file\n`))
    expect(process.env[KEY]).toBe('from-shell')
  })

  it('still reads the other variables when one is already set', () => {
    process.env[KEY] = 'from-shell'
    loadDotEnv(envFile(`${KEY}=from-file\n${OTHER}=from-file\n`))
    expect(process.env[OTHER]).toBe('from-file')
  })

  it('does not validate what it read — an unquoted # truncates the value', () => {
    // Node's leniency, pinned because it is the one way a wrong key reaches the
    // SDK looking right. `.env.example` says to quote a value containing #.
    loadDotEnv(envFile(`${KEY}=ab#cd\n${OTHER}="ef#gh"\n`))
    expect(process.env[KEY]).toBe('ab')
    expect(process.env[OTHER]).toBe('ef#gh')
  })
})
