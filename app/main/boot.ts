import { app, dialog } from 'electron'
import { runtimeLibraryPath } from './runtime-path'

/**
 * The main process's first code (KV-19), before anything imports the SDK.
 *
 * The SDK loads its native runtime the moment it is imported, and the bundle
 * hoists every `require` of a dependency above the module's own code — so a
 * line in `index.ts` setting where the runtime is would run after the SDK had
 * already looked. This entry sets it, and only then loads the app.
 *
 * In a packaged install the path is set, not defaulted: a value inherited from
 * the environment must not point the SDK at another library (review of #192).
 * In development the SDK resolves its runtime from `node_modules` as it always
 * has, and the environment is left alone.
 */
if (app.isPackaged) {
  const library = runtimeLibraryPath(process.resourcesPath, process.platform)
  if (library === null) delete process.env.SMARTSPECTRA_CAPI_PATH
  else process.env.SMARTSPECTRA_CAPI_PATH = library
}

// Loaded, not imported, so the line above runs first. A failure here — the
// runtime missing or damaged — would otherwise be an unhandled rejection: no
// window, and nothing said. Electron's own dialog for a main-process error is
// what a static import gave; this keeps it.
import('./index').catch((err: unknown) => {
  dialog.showErrorBox('Kinvue could not start', err instanceof Error ? err.message : String(err))
  app.exit(1)
})
