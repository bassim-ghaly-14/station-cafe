import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri expects a fixed port; fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
  },
  // Env variables starting with TAURI_ENV_* are exposed to the frontend
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri supports es2021 on Windows 10+
    target: 'es2021',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // The second pattern covers the LOCAL WEB surface in /web — the standalone
    // browser app served to a phone. It is deliberately outside `src`: it is
    // not part of the Tauri desktop bundle, pulls in no Tauri dependency, and
    // is shipped verbatim to the browser. It is still plain ES modules, so the
    // same runner and the same jsdom environment exercise it unchanged.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'web/**/*.{test,spec}.js'],
  },
})
