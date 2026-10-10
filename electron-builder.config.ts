import type { Configuration } from 'electron-builder'

/**
 * The Windows installer (KV-19). What each line is for, and what was decided,
 * is in ARCHITECTURE.md under "Packaging and distribution";
 * `tests/packaging.test.ts` holds the lines that decision depends on.
 *
 *   npm run dist
 *
 * builds `dist/Kinvue-Setup-<version>.exe`, unsigned. An unsigned build never
 * updates itself: there is no updater in it yet, and the one that comes (#19's
 * release PR) runs only in a build the signing workflow made.
 *
 * TypeScript rather than YAML, so `tsc` checks it against electron-builder's
 * own types and the test reads it as electron-builder does.
 */
const config = {
  // The installer's identity on Windows: its uninstall entry and the taskbar's
  // app id. Never change it — a new one is a different app beside the old.
  appId: 'app.kinvue',
  productName: 'Kinvue',
  artifactName: 'Kinvue-Setup-${version}.${ext}',

  directories: { output: 'dist', buildResources: 'build' },

  // The built app, and the dependencies it needs at run time. Every platform's
  // SDK runtime is left out of the archive: the three that are not Windows's
  // are not this installer's (about 260 MB between them), and Windows's cannot
  // be loaded from inside an archive at all, so it goes beside it, below. koffi
  // ships its native module for eighteen platforms, 1.5 MB each; only Windows
  // x64's is ever loaded here.
  files: [
    'out/**/*',
    'package.json',
    '!node_modules/@smartspectra/node-sdk-*/**',
    '!node_modules/koffi/build/koffi/!(win32_x64)/**',
  ],

  // The SDK's Windows runtime beside the archive, where the operating system's
  // loader can open it. `app/main/boot.ts` points the SDK at it
  // (`SMARTSPECTRA_CAPI_PATH`); `app/main/runtime-path.ts` names the folder.
  extraResources: [
    {
      from: 'node_modules/@smartspectra/node-sdk-win32-x64',
      to: 'smartspectra-runtime',
      filter: ['**/*', '!package.json'],
    },
  ],

  asar: true,
  // koffi ships prebuilt binaries for every platform; nothing here is compiled.
  npmRebuild: false,

  // Flipped on the packaged binary (Electron's checklist item 19).
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    grantFileProtocolExtraPrivileges: false,
    loadBrowserProcessSpecificV8Snapshot: false,
  },

  win: { target: [{ target: 'nsis', arch: ['x64'] }] },

  // One click, for this account only, with no administrator prompt: installing
  // an update on quit then needs none either (review of #192).
  nsis: { oneClick: true, perMachine: false },

  // Nothing is published from here. The release workflow, the signing and the
  // update channel are #19's third PR.
  publish: null,
} satisfies Configuration

export default config
