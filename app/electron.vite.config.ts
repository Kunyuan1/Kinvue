import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// electron-vite defaults to src/{main,preload,renderer}. This app uses
// {main,preload,renderer} beside this file, and imports the framework-free core
// as the @kinvue/core workspace (KV-38), so every entry is named explicitly
// below. See ARCHITECTURE.md for why core/ is kept out of app/.
//
// @kinvue/core is a devDependency of this app, never a dependency: the plugin
// below externalises dependencies, and core is TypeScript source with no build
// of its own, so it has to be bundled. `tests/workspaces.test.ts` pins it.

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
