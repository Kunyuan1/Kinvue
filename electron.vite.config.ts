import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// electron-vite defaults to src/{main,preload,renderer}. This repo uses
// app/{main,preload,renderer} + a framework-free core/, so every entry is named
// explicitly below. See ARCHITECTURE.md for why core/ is kept out of app/.
const core = resolve(__dirname, 'core')

export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps @smartspectra/node-sdk OUT of the bundle.
    // The SDK loads a platform-specific native runtime through koffi (FFI) at
    // require time; bundling it breaks that lookup. Do not remove this.
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@core': core } },
    build: {
      outDir: 'out/main',
      // Two entries (KV-19): `boot` runs first and sets where the SDK's native
      // runtime is, then loads `index`. One bundle would hoist the SDK's
      // require above it. See app/main/boot.ts.
      lib: {
        entry: {
          boot: resolve(__dirname, 'app/main/boot.ts'),
          index: resolve(__dirname, 'app/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // The capture reply is decoded here (KV-89), so the preload now bundles a
    // little of core/ rather than only its types.
    resolve: { alias: { '@core': core } },
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'app/preload/index.ts') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'app/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@core': core, '@renderer': resolve(__dirname, 'app/renderer') },
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, 'app/renderer/index.html') },
    },
  },
})
