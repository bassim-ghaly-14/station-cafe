/**
 * Station Cafe — LOCAL WEB: entry point.
 *
 * The only thing this file does is mount the app onto `#app`. It is a separate
 * module from `ui.js` so the UI can be imported and driven by a test without
 * any of this bootstrapping running.
 *
 * No bundler, no framework, no import map: the browser loads these three
 * modules natively as ES modules over the LAN, which every current iOS and
 * Android browser supports.
 */

import { LocalWebApp } from './ui.js'

const root = document.getElementById('app')

if (root) {
  const app = new LocalWebApp({ root })
  void app.start()
  // Exposed for manual inspection from a phone's remote debugger; it holds the
  // session token in memory, so it is deliberately NOT a global the page can
  // read from another origin — same-origin script already has that access.
  globalThis.stationLocalApp = app
}
