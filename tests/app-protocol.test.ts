import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { APP_PAGE_URL, appFileFor } from '../app/main/app-protocol'
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

describe('runtimeLibraryPath', () => {
  it('points the SDK beside the archive on Windows, and leaves other platforms to it', () => {
    expect(runtimeLibraryPath('C:\\Kinvue\\resources', 'win32')).toBe(
      join('C:\\Kinvue\\resources', 'smartspectra-runtime', 'smartspectra_capi.dll'),
    )
    expect(runtimeLibraryPath('/opt/Kinvue/resources', 'linux')).toBeNull()
    expect(runtimeLibraryPath('/Applications/Kinvue.app/Contents/Resources', 'darwin')).toBeNull()
  })
})
