import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { APP_PAGE_URL, appFileFor, serveApp } from '../app/main/app-protocol'
import { runtimeLibraryPath } from '../app/main/runtime-path'

/**
 * `app://kinvue/` serves the built renderer's files and nothing else (KV-19):
 * Electron's checklist item 18, in place of `file://`.
 */

const ROOT = join('C:', 'Program Files', 'Kinvue', 'resources', 'app.asar', 'out', 'renderer')

describe('appFileFor', () => {
  it('serves the page, and the files beside it', () => {
    expect(appFileFor(APP_PAGE_URL, ROOT)).toBe(join(ROOT, 'index.html'))
    expect(appFileFor('app://kinvue/', ROOT)).toBe(join(ROOT, 'index.html'))
    expect(appFileFor('app://kinvue/assets/index-abc.js', ROOT)).toBe(
      join(ROOT, 'assets', 'index-abc.js'),
    )
    // A query or a fragment does not name another file.
    expect(appFileFor('app://kinvue/index.html?x=1#cards', ROOT)).toBe(join(ROOT, 'index.html'))
  })

  it('serves nothing outside the renderer, however the path climbs', () => {
    for (const url of [
      'app://kinvue/../main/index.js',
      'app://kinvue/%2e%2e/main/index.js',
      'app://kinvue/assets/%2e%2e%2f%2e%2e%2fmain%2findex.js',
      'app://kinvue/..%5c..%5cmain%5cindex.js',
      'app://kinvue/%5c%5cserver%5cshare%5cx',
      'app://kinvue/C:%5cWindows%5cwin.ini',
      'app://kinvue/index.html%00.png',
      'app://kinvue/%E0%A4%A',
    ]) {
      const file = appFileFor(url, ROOT)
      // Either refused, or a file still inside the renderer folder: the URL
      // parser itself folds `/../main` into `/main`, which is under the root.
      if (file !== null) {
        expect(file.startsWith(ROOT + '\\') || file.startsWith(ROOT + '/'), url).toBe(true)
      }
    }
    expect(appFileFor('app://kinvue/..%5c..%5cmain%5cindex.js', ROOT)).toBeNull()
    expect(appFileFor('app://kinvue/index.html%00.png', ROOT)).toBeNull()
    expect(appFileFor('app://kinvue/%E0%A4%A', ROOT)).toBeNull()
  })

  it('serves nothing for another scheme, another host, or what is not a URL', () => {
    for (const url of [
      'file:///C:/Program%20Files/Kinvue/resources/app.asar/out/renderer/index.html',
      'app://other/index.html',
      'app://kinvue.attacker.example/index.html',
      'https://kinvue/index.html',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(appFileFor(url, ROOT), url).toBeNull()
    }
  })
})

describe('serveApp (review of #193)', () => {
  // A stand-in for `net.fetch` over `file:`: reads the file, and fails on a
  // folder or a missing file as a real read would.
  const fetchFile = async (fileUrl: string): Promise<Response> =>
    new Response(await readFile(fileURLToPath(fileUrl)))

  it('serves a file, and 404s a folder, a missing file, or anything refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kinvue-renderer-'))
    try {
      mkdirSync(join(root, 'assets'))
      writeFileSync(join(root, 'index.html'), '<p>ours</p>')
      const page = await serveApp(APP_PAGE_URL, root, fetchFile)
      expect(page.status).toBe(200)
      expect(await page.text()).toBe('<p>ours</p>')
      for (const url of [
        'app://kinvue/assets',
        'app://kinvue/assets/missing.js',
        'app://kinvue/..%5c..%5cmain%5cboot.js',
        'app://other/index.html',
      ]) {
        expect((await serveApp(url, root, fetchFile)).status, url).toBe(404)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never reads a file it refused', async () => {
    let asked = 0
    const counting = async (): Promise<Response> => {
      asked++
      return new Response('x')
    }
    await serveApp('app://kinvue/..%5c..%5cmain%5cboot.js', ROOT, counting)
    await serveApp('app://other/index.html', ROOT, counting)
    expect(asked).toBe(0)
  })

  it('turns a read that answers with an error into a 404, not a page of it', async () => {
    const failing = async (): Promise<Response> => new Response('denied', { status: 500 })
    expect((await serveApp(APP_PAGE_URL, ROOT, failing)).status).toBe(404)
  })
})

describe('runtimeLibraryPath', () => {
  it('points the SDK beside the archive on Windows, and nowhere on other platforms', () => {
    expect(runtimeLibraryPath('C:\\Kinvue\\resources', 'win32')).toBe(
      join('C:\\Kinvue\\resources', 'smartspectra-runtime', 'smartspectra_capi.dll'),
    )
    expect(runtimeLibraryPath('/opt/Kinvue/resources', 'linux')).toBeNull()
    expect(runtimeLibraryPath('/Applications/Kinvue.app/Contents/Resources', 'darwin')).toBeNull()
  })
})
