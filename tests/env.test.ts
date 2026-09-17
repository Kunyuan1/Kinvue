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
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinvue-env-'))
  delete process.env[KEY]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env[KEY]
})

const envFile = (contents: string): string => {
  const path = join(dir, '.env')
  writeFileSync(path, contents)
  return path
}

describe('loadDotEnv', () => {
  it('reads variables out of the file', () => {
    loadDotEnv(envFile(`${KEY}=from-file\n`))
    expect(process.env[KEY]).toBe('from-file')
  })

  it('treats a missing file as the normal case, not an error', () => {
    expect(() => loadDotEnv(join(dir, 'nothing-here'))).not.toThrow()
    expect(process.env[KEY]).toBeUndefined()
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
    loadDotEnv(envFile(`${KEY}=from-file\nKV51_TEST_OTHER=from-file\n`))
    expect(process.env.KV51_TEST_OTHER).toBe('from-file')
    delete process.env.KV51_TEST_OTHER
  })
})
