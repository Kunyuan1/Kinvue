import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// electron-vite defaults to src/{main,preload,renderer}. This app uses
// {main,preload,renderer} beside this file, and imports the framework-free core
// as the @kinvue/core workspace (KV-38), so every entry is named explicitly
// below. See ARCHITECTURE.md for why core/ is kept out of app/.
//
// Run it from app/, as the root's scripts do (`-w app`). electron-vite reads
// package.json from the working directory, not from beside this file, so from
// the root it finds no `main` and no dependencies, and the plugin below then
// bundles the SDK it exists to keep out.
//
// @kinvue/core is bundled, since it is TypeScript source with no build of its
// own, and the plugin below leaves every `dependencies` entry as a runtime
// require. Listing core as a devDependency is how it is bundled here; that is a
// choice, not the only way: `externalizeDepsPlugin({ exclude: [...] })` would
// bundle it as a dependency too, at the price of core's sources in the archive
// unless the builder's `files` left them out (review of #214). It keeps the
// installer the same as before the split. `tests/workspaces.test.ts` pins it.

export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps @smartspectra/node-sdk OUT of the bundle.
    // The SDK loads a platform-specific native runtime through koffi (FFI) at
    // require time; bundling it breaks that lookup. Do not remove this.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      // Two entries (KV-19): `boot` runs first and sets where the SDK's native
      // runtime is, then loads `index`. One bundle would hoist the SDK's
      // require above it. See app/main/boot.ts.
      lib: {
        entry: {
          boot: resolve(__dirname, 'main/boot.ts'),
          index: resolve(__dirname, 'main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // The capture reply is decoded here (KV-89), so the preload bundles a
    // little of core/ rather than only its types.
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'preload/index.ts') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'renderer') },
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, 'renderer/index.html') },
    },
  },
})
