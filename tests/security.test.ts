import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appPage, isAppUrl, isTrustedSender } from '../app/main/security'

/**
 * The window's trust boundary (KV-29): the one page the window may be at, and
 * the only frame the main process answers. Built both ways the app runs.
 */
const DEV = appPage('http://localhost:5173', 'file:///C:/app/out/renderer/index.html')
const BUILT = appPage(undefined, 'file:///C:/Program%20Files/Kinvue/out/renderer/index.html')

describe('appPage', () => {
  it('is the dev server when electron-vite names one, and the built file otherwise', () => {
    expect(DEV).toEqual({ kind: 'dev', origin: 'http://localhost:5173' })
    expect(BUILT).toEqual({ kind: 'file', pathname: '/C:/Program%20Files/Kinvue/out/renderer/index.html' })
    // An empty variable is not a dev server.
    expect(appPage('', 'file:///C:/app/index.html').kind).toBe('file')
  })
})

describe('isAppUrl', () => {
  it("accepts Kinvue's own page, with or without a query or fragment", () => {
    for (const url of ['http://localhost:5173', 'http://localhost:5173/', 'http://localhost:5173/?x=1#top']) {
      expect(isAppUrl(url, DEV), url).toBe(true)
    }
    for (const url of [
      'file:///C:/Program%20Files/Kinvue/out/renderer/index.html',
      'file:///C:/Program%20Files/Kinvue/out/renderer/index.html#cards',
    ]) {
      expect(isAppUrl(url, BUILT), url).toBe(true)
    }
  })

  it('refuses another origin, another file, another scheme, and anything not a URL', () => {
    for (const url of [
      'https://example.com',
      'http://localhost:5174',
      'https://localhost:5173',
      'http://127.0.0.1:5173',
      'file:///C:/app/out/renderer/index.html',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isAppUrl(url, DEV), url).toBe(false)
    }
    for (const url of [
      'file:///C:/Program%20Files/Kinvue/out/renderer/other.html',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'http://localhost:5173',
      'https://example.com/C:/Program%20Files/Kinvue/out/renderer/index.html',
    ]) {
      expect(isAppUrl(url, BUILT), url).toBe(false)
    }
  })
})

describe('isTrustedSender', () => {
  it("answers only the main frame of Kinvue's own page", () => {
    expect(isTrustedSender({ url: 'http://localhost:5173/', isMainFrame: true }, DEV)).toBe(true)
    // Our page in a subframe, another page in the main frame, a frame already gone.
    expect(isTrustedSender({ url: 'http://localhost:5173/', isMainFrame: false }, DEV)).toBe(false)
    expect(isTrustedSender({ url: 'https://example.com/', isMainFrame: true }, DEV)).toBe(false)
    expect(isTrustedSender(null, DEV)).toBe(false)
  })
})

describe('the main process holds to it', () => {
  // Read as text, like the lint-boundary tests: `index.ts` imports Electron and
  // cannot load in the plain suite. What matters is that the next handler
  // cannot be added past the check, and the sandbox cannot quietly go off.
  const main = readFileSync('app/main/index.ts', 'utf8')

  it('registers every IPC handler through the sender check', () => {
    // One `ipcMain.handle(` — the one inside `handle`, which checks the sender.
    expect(main.match(/ipcMain\.handle\(/g)?.length).toBe(1)
    expect(main).not.toMatch(/ipcMain\.on\(/)
  })

  it('keeps the renderer sandboxed', () => {
    expect(main).toMatch(/sandbox: true/)
    expect(main).not.toMatch(/sandbox: false/)
    expect(main).toMatch(/app\.enableSandbox\(\)/)
  })
})
