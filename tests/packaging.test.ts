import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import config from '../electron-builder.config'
import pkg from '../package.json'
import { RUNTIME_FOLDER } from '../app/main/runtime-path'

/**
 * The installer's configuration holds what #19 decided (KV-19, ARCHITECTURE.md
 * *Packaging and distribution*). Each line here would build without complaint
 * if it were wrong — an installer carrying four runtimes, one that cannot load
 * its own, one that asks for an administrator to update — so each is held.
 */

describe('the installer (KV-19)', () => {
  it('is built from this file, named, since electron-builder would not find it', () => {
    // electron-builder looks only for `electron-builder.<ext>`, and builds with
    // its defaults when it finds none — an installer named `kinvue`, rebuilt
    // natives, no fuses — and says nothing. Found building it.
    expect(pkg.scripts.dist).toContain('electron-builder --config electron-builder.config.ts ')
  })

  it('starts the app at boot, which sets the runtime path before the SDK loads', () => {
    expect(pkg.main).toBe('./out/main/boot.js')
  })

  it('leaves every SDK runtime out of the archive, and puts Windows\'s beside it', () => {
    expect(config.files).toContain('!node_modules/@smartspectra/node-sdk-*/**')
    expect(config.files).toContain('!node_modules/koffi/build/koffi/!(win32_x64)/**')
    expect(config.asar).toBe(true)
    const [runtime] = config.extraResources
    expect(runtime).toEqual({
      from: 'node_modules/@smartspectra/node-sdk-win32-x64',
      to: RUNTIME_FOLDER,
      filter: ['**/*', '!package.json'],
    })
    // The folder it copies is the one installed, with the library the SDK loads.
    expect(existsSync(`${runtime!.from}/smartspectra_capi.dll`)).toBe(true)
  })

  it('is a one-click install for this account, needing no administrator', () => {
    expect(config.nsis).toEqual({ oneClick: true, perMachine: false })
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
  })

  it('flips the fuses ARCHITECTURE.md lists (checklist item 19)', () => {
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      enableCookieEncryption: true,
      grantFileProtocolExtraPrivileges: false,
      loadBrowserProcessSpecificV8Snapshot: false,
    })
  })

  it('publishes nothing, so this build has no update channel to be pointed at', () => {
    // The release PR adds publishing, signing and the updater together; until
    // then nothing built here can reach or be reached by GitHub Releases.
    expect(config.publish).toBeNull()
    expect(pkg.dependencies).not.toHaveProperty('electron-updater')
  })

  it('keeps the identity Windows knows it by', () => {
    // A new appId is a different app installed beside the old one.
    expect(config.appId).toBe('io.github.kunyuan1.kinvue')
    expect(config.productName).toBe('Kinvue')
  })
})
