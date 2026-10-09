import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_PAGE_URL } from '../app/main/app-protocol'
import { isAppUrl, isTrustedSender, resolveAppPage } from '../app/main/security'

/**
 * The window's trust boundary (KV-29): the one page the window may be at, and
 * the only frame the main process answers. Built both ways the app runs: the
 * dev server, and the built page at `app://kinvue/` (KV-19).
 */
const BUILT_URL = APP_PAGE_URL
const DEV = resolveAppPage('http://localhost:5173', BUILT_URL).page
const BUILT = resolveAppPage(undefined, BUILT_URL).page

describe('resolveAppPage', () => {
  it('is the dev server when electron-vite names one, and the app:// page otherwise', () => {
    expect(DEV).toEqual({ kind: 'dev', origin: 'http://localhost:5173', url: 'http://localhost:5173/' })
    expect(BUILT).toEqual({
      kind: 'app',
      protocol: 'app:',
      host: 'kinvue',
      pathname: '/index.html',
      url: 'app://kinvue/index.html',
    })
    // An empty variable is not a dev server.
    expect(resolveAppPage('', BUILT_URL)).toEqual({ page: BUILT, problem: null })
  })

  it('never matches by an opaque origin, which made every page without one ours (review of #169)', () => {
    // A file: dev URL is a file page, matched by its path.
    const fileDev = resolveAppPage('file:///C:/app/out/renderer/index.html', BUILT_URL)
    expect(fileDev).toEqual({
      page: { kind: 'file', pathname: '/C:/app/out/renderer/index.html', url: 'file:///C:/app/out/renderer/index.html' },
      problem: null,
    })
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'about:blank', 'file:///C:/Windows/win.ini']) {
      expect(isAppUrl(url, fileDev.page), url).toBe(false)
    }
    // Anything else falls back to the built page, and says why.
    for (const devUrl of ['data:text/html,x', 'about:blank', 'javascript:alert(1)', 'file://host/C:/x.html']) {
      const resolved = resolveAppPage(devUrl, BUILT_URL)
      expect(resolved.page, devUrl).toEqual(BUILT)
      expect(resolved.problem, devUrl).toMatch(/must be an http\(s\) or local file URL/)
    }
  })

  it('never matches the app:// page by origin, which Node gives as "null" (review of #192)', () => {
    // The trap, stated: app:, javascript: and data: share an origin in Node.
    expect(new URL(BUILT_URL).origin).toBe('null')
    expect(new URL('javascript:alert(1)').origin).toBe('null')
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'about:blank', 'blob:null/x']) {
      expect(isAppUrl(url, BUILT), url).toBe(false)
    }
  })

  it('reports an address that is not one, rather than throwing before there is a window (review of #169)', () => {
    // `localhost:5173` parses — as the scheme `localhost:` — so it is refused for
    // its scheme; a string that does not parse at all is refused for that.
    expect(resolveAppPage('localhost:5173', BUILT_URL).problem).toMatch(/must be an http\(s\) or local file URL/)
    expect(resolveAppPage('not a url', BUILT_URL)).toEqual({
      page: BUILT,
      problem: expect.stringMatching(/is not a URL/),
    })
  })

  it('loads exactly the URL it checks (review of #169)', () => {
    // The app compares every navigation and IPC call against this page; if the
    // URL it loads and the URL it checks disagree by one character, it refuses
    // its own page. `createWindow` loads `page.url`, so they are one string —
    // for the built page, and for a file: dev page whose path has a space and a
    // non-ASCII segment in it.
    const files = [
      pathToFileURL(String.raw`C:\Program Files\Kinvue\out\renderer\index.html`, { windows: true }).href,
      pathToFileURL(String.raw`C:\Users\Zoë Müller\AppData\Local\Kinvue\out\renderer\index.html`, { windows: true }).href,
      pathToFileURL('/Applications/Kinvue Café.app/Contents/Resources/out/renderer/index.html', { windows: false }).href,
    ]
    const pages = [BUILT, ...files.map((href) => resolveAppPage(href, BUILT_URL).page)]
    for (const page of pages) {
      expect(isAppUrl(page.url, page), page.url).toBe(true)
      // And the same URL as Chromium commits it, which normalises it again.
      expect(isAppUrl(new URL(page.url).href, page), page.url).toBe(true)
    }
  })
})

describe('isAppUrl', () => {
  it("accepts Kinvue's own page, with or without a query or fragment", () => {
    for (const url of ['http://localhost:5173', 'http://localhost:5173/', 'http://localhost:5173/?x=1#top']) {
      expect(isAppUrl(url, DEV), url).toBe(true)
    }
    for (const url of ['app://kinvue/index.html', 'app://kinvue/index.html#cards', 'app://kinvue/index.html?x=1']) {
      expect(isAppUrl(url, BUILT), url).toBe(true)
    }
  })

  it('refuses another origin, another file, another scheme, and anything not a URL', () => {
    for (const url of [
      'https://example.com',
      'http://localhost:5174',
      'https://localhost:5173',
      'http://127.0.0.1:5173',
      'app://kinvue/index.html',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isAppUrl(url, DEV), url).toBe(false)
    }
    for (const url of [
      // Another host, another port, another file, or our path under another scheme.
      'app://other/index.html',
      'app://kinvue.attacker.example/index.html',
      'app://kinvue:8080/index.html',
      'app://kinvue/other.html',
      'app://kinvue/assets/index.html',
      'file:///C:/Program%20Files/Kinvue/out/renderer/index.html',
      'https://kinvue/index.html',
      'http://localhost:5173',
      'not a url',
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

describe('the main process turns the sandbox on', () => {
  // What may not be done is `tests/lint-main.test.ts`'s: no IPC past the sender
  // check, and no security option as anything but a literal, across app/main.
  // A lint rule cannot say what must be *there*, so this does — read from the
  // syntax tree, not the text, so a comment saying `sandbox: true` does not
  // count (review of #169). `index.ts` imports Electron and cannot be loaded here.
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync('app/main/index.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const nodes: ts.Node[] = []
  const walk = (node: ts.Node): void => {
    nodes.push(node)
    ts.forEachChild(node, walk)
  }
  walk(source)

  it('calls app.enableSandbox() at the top level, before anything is ready', () => {
    const calls = source.statements.filter(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        s.expression.expression.getText(source) === 'app.enableSandbox',
    )
    expect(calls).toHaveLength(1)
  })

  it('creates the window with sandbox: true', () => {
    const sandbox = nodes.filter(
      (n): n is ts.PropertyAssignment =>
        ts.isPropertyAssignment(n) && n.name.getText(source) === 'sandbox',
    )
    expect(sandbox.map((p) => p.initializer.kind)).toEqual([ts.SyntaxKind.TrueKeyword])
  })
})
