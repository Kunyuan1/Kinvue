import { app, dialog, protocol } from 'electron'
import { APP_SCHEME } from './app-protocol'
import { runtimeLibraryPath } from './runtime-path'

/**
 * The main process's first code (KV-19): everything that must happen before
 * the app is `ready`, or before anything imports the SDK. `index.ts` owns
 * everything from `ready` on.
 *
 * Here, not in `index.ts`, because `index.ts` is reached by a dynamic import
 * below: anything there runs before `ready` only by an accident of the bundle's
 * module format, and stops the day the format changes (review of #193). Here it
 * runs first because it is first.
 */

// Every renderer sandboxed, this window's and any other that ever exists: the
// preload needs only `contextBridge` and `ipcRenderer`, which a sandboxed
// preload keeps. Before `ready`, as Electron requires (KV-29).
app.enableSandbox()

// The built page's own scheme, in place of `file://` (Electron's checklist
// item 18), registered before `ready` as Electron requires: standard, so the
// page has an origin and `'self'` in its CSP matches its own bundle, and
// secure, as `file://` was. What it serves is `app-protocol.ts`'s; what is "our
// page" is `security.ts`'s, by protocol, host and path.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
])

/**
 * Where the SDK's runtime is, set before the SDK is imported. The SDK loads its
 * runtime the moment it is imported, and the bundle hoists every dependency's
 * `require` above the module's own code — so a line in `index.ts` would run
 * after the SDK had already looked.
 *
 * In a packaged install the path is set, not defaulted: a value inherited from
 * the environment must not point the SDK at another library (review of #192).
 * A packaged build with no runtime for its platform is a packaging mistake —
 * every SDK runtime is left out of the archive, so the SDK's own lookup has
 * nothing to find — and is said as one (review of #193). In development the
 * SDK resolves its runtime from `node_modules` as it always has.
 */
function runtimeProblem(): string | null {
  if (!app.isPackaged) return null
  const library = runtimeLibraryPath(process.resourcesPath, process.platform)
  if (library === null) {
    return (
      `This copy of Kinvue was packaged without the SmartSpectra runtime for ` +
      `${process.platform}, so it cannot take a reading here. It is a fault in how it was ` +
      `built, not in this computer.`
    )
  }
  process.env.SMARTSPECTRA_CAPI_PATH = library
  return null
}

const problem = runtimeProblem()
if (problem !== null) {
  dialog.showErrorBox('Kinvue could not start', problem)
  app.exit(1)
} else {
  // Loaded, not imported, so the lines above run first. A failure here — the
  // runtime missing or damaged — would otherwise be an unhandled rejection: no
  // window, and nothing said. Electron's own dialog for a main-process error is
  // what a static import gave; this keeps it.
  import('./index').catch((err: unknown) => {
    dialog.showErrorBox('Kinvue could not start', err instanceof Error ? err.message : String(err))
    app.exit(1)
  })
}
