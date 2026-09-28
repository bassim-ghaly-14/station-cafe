import '@testing-library/jest-dom/vitest'

/**
 * Default the test environment to the Tauri desktop shell.
 *
 * `src/services/ipc.ts` picks a transport by asking whether it is running
 * inside Tauri. Most suites here assert the desktop IPC contract — the exact
 * command name and payload shape — so that has to be the default, stated once
 * and visibly, rather than each suite rediscovering it.
 *
 * A suite that exercises the BROWSER transport deletes this marker and stubs
 * `fetch` instead, so both paths are covered deliberately rather than by
 * accident.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

window.__TAURI_INTERNALS__ = {}
