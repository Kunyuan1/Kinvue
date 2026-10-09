import { join } from 'node:path'

/**
 * Where a packaged install keeps the SDK's native runtime (KV-19): beside the
 * app's archive, under `resources/`, never inside it. The SDK finds its library
 * with `require.resolve` and hands the path to `koffi.load()`, which opens it
 * with the operating system's own loader — and that loader knows nothing of
 * archives, so a runtime inside `app.asar` cannot be loaded at all
 * (ARCHITECTURE.md, *Packaging and distribution*).
 *
 * The folder name is `electron-builder.yml`'s `extraResources` destination;
 * `tests/packaging.test.ts` holds the two to each other.
 */
export const RUNTIME_FOLDER = 'smartspectra-runtime'

/** The library the SDK loads first, per platform this is packaged for. Windows first (KV-19). */
const LIBRARY: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'smartspectra_capi.dll',
}

/**
 * The runtime library's path in a packaged install on `platform`, for the SDK's
 * own `SMARTSPECTRA_CAPI_PATH` override; null on a platform not packaged yet,
 * where the SDK's own resolution is left to say what is missing.
 */
export function runtimeLibraryPath(
  resourcesPath: string,
  platform: NodeJS.Platform,
): string | null {
  const library = LIBRARY[platform]
  return library === undefined ? null : join(resourcesPath, RUNTIME_FOLDER, library)
}
