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
      lib: { entry: resolve(__dirname, 'app/main/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
