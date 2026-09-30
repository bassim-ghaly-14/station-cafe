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
    // There is deliberately only ONE frontend in this repository: `src/`. The
    // LAN browser app served to a phone is the SAME bundle the till runs — it
    // is the embedded `dist/` that the Rust listener hands out, not a separate
    // app — so there is no second application test surface here. A previous
    // version of this comment described a standalone `web/` directory that does
    // not exist; the include patterns below are therefore `src/` and `tests/`.
    //
    // `tests/` holds the ONE suite that must inspect the real build output on
    // disk. It cannot live under `src/`, because `tsconfig.app.json` withholds
    // Node types from the application bundle on purpose and this suite reads
    // `dist/` directly. It runs in the same jsdom environment as everything else:
    // it does no DOM work, and jsdom keeps the runner uniform.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
  },
})
