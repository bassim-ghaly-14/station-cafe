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

/**
 * Default the test environment to a DESKTOP viewport, the same shell the
 * `__TAURI_INTERNALS__` marker above already declares.
 *
 * This matters because `useIsWide()` is the single source of the table-vs-record
 * decision, and jsdom does not implement `matchMedia` at all: without a stub,
 * every hook would read "not wide" and every suite would silently exercise the
 * PHONE presentation of the application. That is the wrong default for a test
 * run — a desktop application must be tested as a desktop first, or a desktop
 * regression passes unnoticed.
 *
 * A suite that verifies a phone layout overrides this with
 * `setViewportWidth(360)` and restores it afterwards, exactly the way
 * `TodayInvoicesPage.test.tsx` already stubs a narrow viewport by hand. The
 * helper is exported from this module so those suites share one implementation
 * rather than each re-deriving a `matchMedia` mock.
 */
const DEFAULT_VIEWPORT_WIDTH = 1280

let viewportWidth = DEFAULT_VIEWPORT_WIDTH

/** Makes `useIsWide()` (and every other media query) report this width. */
export function setViewportWidth(width: number) {
  viewportWidth = width
}

/** Restores the default desktop viewport. */
export function resetViewportWidth() {
  viewportWidth = DEFAULT_VIEWPORT_WIDTH
}

/**
 * A minimal but honest `matchMedia`: it evaluates the width- and
 * height-conditional `min-`/`max-` prefixes in `rem` and `px` and reports
 * `false` for everything else, which is what a browser does for a feature this
 * application never queries.
 */
window.matchMedia = ((query: string) => {
  const rem = 16
  const px = (value: string) =>
    value.endsWith('rem') ? Number.parseFloat(value) * rem : Number.parseFloat(value)

  let matches = false
  const min = /\(min-width:\s*([\d.]+(?:rem|px))\)/.exec(query)
  const max = /\(max-width:\s*([\d.]+(?:rem|px))\)/.exec(query)
  if (min) matches = viewportWidth >= px(min[1])
  else if (max) matches = viewportWidth <= px(max[1])

  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList
}) as typeof window.matchMedia
