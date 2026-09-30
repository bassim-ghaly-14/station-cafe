/**
 * THE LAN CONTRACT — what a phone on the cafe Wi-Fi actually loads.
 *
 * WHY THIS FILE IS NOT UNDER `src/`
 * -------------------------------
 * `tsconfig.app.json` deliberately excludes Node types from the application
 * bundle: the frontend must never grow a dependency on the filesystem, because
 * it is compiled into something that runs in a browser on a phone. The existing
 * `src/` suites honour that by reading files through Vite's `?raw` imports.
 *
 * This suite cannot. Its whole purpose is to inspect the REAL build output —
 * `dist/`, with its hashed filenames — which means enumerating a directory and
 * reading files whose names are not known until the build runs. That is
 * inherently a Node operation, so this suite lives under `tests/` and is
 * typechecked by `tsconfig.node.json` instead. It is still plain Vitest and the
 * same runner, and it still ships in no bundle: nothing under `src/` imports it.
 *
 * Every other suite proves a RULE. This one proves the ARTIFACT. The rules in
 * `web.rs` and `releaseIntegrity.test.ts` are only worth anything if the real
 * production bundle that the Rust listener serves out of its embedded asset map
 * satisfies them, and that map is compiled from `dist/`. So this suite reads the
 * ACTUAL build output and audits it.
 *
 * Why that distinction is the whole point
 * ---------------------------------------
 * The QR code encodes `http://<lan-ip>:<port>/`. A phone scanning it fetches
 * `dist/index.html`, follows it to the hashed JS and CSS bundles, boots, and
 * calls `/api/v1/cmd/*`. If ANY step of that chain names a remote origin, the
 * phone on a cafe LAN with no internet hangs on it — and the failure looks like
 * a broken app, not a missing dependency, because no other check in this
 * repository ever loads a page.
 *
 * Each reference is therefore judged by what it ACTUALLY does in a browser:
 *
 * - `src`/`href`/`url()`/`@import` are FETCHED. A remote one is a hard failure.
 * - A protocol-relative `//host/x` is fetched too, and is easy to miss.
 * - `og:image` / `twitter:image` are CRAWLER metadata: never fetched at
 *   runtime, and blocked by the CSP besides. `publicMetadata.test.ts` owns
 *   those, and this suite deliberately does not duplicate or contradict it.
 *
 * Determinism: this reads local files only. It never touches the network, never
 * resolves a hostname, and does not depend on the machine's connectivity, so it
 * behaves identically on a developer laptop with internet and on a cafe PC with
 * none.
 *
 * The build is a PRECONDITION, not a fallback: a missing `dist/` fails the first
 * test loudly rather than letting every other assertion silently skip, which is
 * how an "offline is fine" suite ends up verifying nothing at all.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')

const built = existsSync(DIST)

/**
 * Every file the build emitted, as a `/`-separated path relative to `dist/`.
 *
 * Dot-files are excluded: `.DS_Store` is a gitignored macOS Finder artifact that
 * can sit in any build directory and is never application content. Including it
 * would make the suite report a machine-specific failure that has nothing to do
 * with the LAN path.
 */
function distFiles(dir = DIST, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name: string) => {
    if (name.startsWith('.')) return []
    const full = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    return statSync(full).isDirectory() ? distFiles(full, rel) : [rel]
  })
}

/** Strip `//` line comments and slash-star block comments from Rust source. */
function stripRustComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Strip comments so a URL inside a CSS comment is not counted as a reference. */
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** `src`/`href` values the BROWSER fetches, across the whole document. */
function fetchedReferences(document: string): string[] {
  const refs: string[] = []
  for (const tag of document.match(/<(?:script|link|img|source|iframe|video|audio)\b[^>]*>/gi) ??
    []) {
    const value = tag.match(/\s(?:src|href)\s*=\s*"([^"]*)"/i)?.[1]
    if (value) refs.push(value)
  }
  return refs
}

describe('production build: the LAN artifact exists', () => {
  it('has a build to audit', () => {
    expect(built, 'dist/ is missing — run `pnpm build` before this suite').toBe(true)
  })

  it('ships the shell plus hashed JS and CSS bundles', () => {
    const files = distFiles()
    expect(files).toContain('index.html')
    expect(files.some((f) => f.startsWith('assets/') && f.endsWith('.js'))).toBe(true)
    expect(files.some((f) => f.startsWith('assets/') && f.endsWith('.css'))).toBe(true)
  })

  it('emits no source map, which would publish the source on the LAN', () => {
    /*
     * `vite.config.ts` enables sourcemaps only under `TAURI_ENV_DEBUG`, so a
     * release build must contain none. A shipped `.map` is a full disclosure of
     * the frontend source to every device on the cafe Wi-Fi — and because
     * `/assets/` is served through `web::asset_key`, it would be reachable at a
     * guessable URL rather than merely sitting unused on disk.
     */
    const maps = distFiles().filter((f) => f.endsWith('.map'))
    expect(maps, `source maps must not ship: ${maps.join(', ')}`).toEqual([])
  })

  it('exposes no database, credential or environment file', () => {
    /*
     * The listener is reachable by every device on the LAN, and Vite copies
     * `public/` to the bundle root WITHOUT fingerprinting — so a stray file
     * there would be served at its own name.
     */
    const forbidden = /\.(db|sqlite|sqlite3|db-journal|db-wal|db-shm|env|pem|key|p12|pfx|log)$/i
    const offenders = distFiles().filter((f) => forbidden.test(f))
    expect(offenders, `must never be bundled: ${offenders.join(', ')}`).toEqual([])
  })
})

describe('production build: the HTML fetches only local resources', () => {
  const html = built ? readFileSync(join(DIST, 'index.html'), 'utf8') : ''

  it('fetches nothing from a remote origin', () => {
    const remote = fetchedReferences(html).filter((r) => /^(https?:)?\/\//i.test(r))
    expect(remote, `index.html fetches remote origins: ${remote.join(', ')}`).toEqual([])
  })

  it('names no protocol-relative reference', () => {
    // `//cdn.example/x.js` LOOKS relative but silently becomes a network fetch
    // in every browser, so it is called out separately rather than left to the
    // remote-origin rule alone.
    for (const ref of fetchedReferences(html)) {
      expect(ref, `"${ref}" is protocol-relative`).not.toMatch(/^\/\//)
    }
  })

  it('references only files that actually exist in the build', () => {
    /*
     * The failure this catches: Vite emits a HASHED name and the shell must name
     * exactly that name. A stale `dist/`, a rename, or a hand-edited template
     * produces a reference to a file that is not there, and the phone gets a
     * silent 404 where it expected a script.
     */
    const local = fetchedReferences(html).filter((r) => r.startsWith('/') && r !== '/')
    expect(local.length, 'the shell must reference its bundle').toBeGreaterThan(0)
    for (const ref of local) {
      expect(
        existsSync(join(DIST, ref.replace(/^\//, ''))),
        `${ref} is referenced but not in dist/`,
      ).toBe(true)
    }
  })

  it('references every emitted bundle file, so none is orphaned', () => {
    // The reverse direction: an emitted bundle nothing references is dead
    // weight in the binary, quietly shipped on every LAN page load forever.
    const emitted = distFiles().filter((f) => f.startsWith('assets/'))
    expect(emitted.length).toBeGreaterThan(0)
    for (const file of emitted) {
      expect(html, `${file} is built but never referenced`).toContain(`/${file}`)
    }
  })

  it('keeps the runtime icons local and present', () => {
    // `favicon` and `apple-touch-icon` are fetched by the browser, so they obey
    // the offline rule and must resolve against the LAN origin.
    const icons = fetchedReferences(html).filter((r) => /\.(png|svg|ico)$/i.test(r))
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon).toMatch(/^\//)
      expect(existsSync(join(DIST, icon.replace(/^\//, '')))).toBe(true)
    }
  })

  it('does not weaken the offline policy to accommodate its own metadata', () => {
    /*
     * `index.html` carries absolute Cloudinary URLs for `og:image`, which is
     * deliberate and inert: a browser never fetches it, and the CSP forbids it.
     * The invariant that keeps that safe is that the CSP stays `'self'`-only.
     * If a future edit opened `img-src` or `connect-src` to make those images
     * work, the running application would start depending on the internet, so
     * the policy is asserted here against the same build.
     */
    const csp = html.match(/http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']+)/i)
    // The shipped HTML relies on the RESPONSE header (`web::CSP`), not a meta
    // tag, so this asserts the absence of a weaker inline one.
    expect(csp, 'the shell must not carry its own CSP meta tag').toBeNull()
    // And the metadata that would tempt such a change is present and absolute.
    expect(html).toContain('og:image')
  })
})

describe('production build: the stylesheet loads nothing remote', () => {
  const cssFiles = built ? distFiles().filter((f) => f.endsWith('.css')) : []
  const css = cssFiles.map((f) => stripCssComments(readFileSync(join(DIST, f), 'utf8'))).join('\n')

  it('has a stylesheet to audit', () => {
    expect(cssFiles.length, 'the build must emit CSS').toBeGreaterThan(0)
  })

  it('imports nothing over the network', () => {
    // `@import` is the two ways a stylesheet reaches the network: a remote URL
    // in parentheses, or a bare quoted remote URL.
    expect(css).not.toMatch(/@import\s+url\(/i)
    expect(css).not.toMatch(/@import\s+["']https?:/i)
  })

  it('loads no remote asset through url()', () => {
    for (const url of [...css.matchAll(/url\(\s*['"]?([^'")]+)/gi)].map((m) => m[1])) {
      expect(url, `CSS url(${url}) is remote`).not.toMatch(/^(https?:)?\/\//i)
      // `data:` is not remote, but it is also not something this stylesheet has
      // any reason to inline; neither form is asserted as forbidden here so the
      // rule stays about the network rather than about encoding choices.
    }
  })

  it('declares no @font-face, so no font is ever fetched', () => {
    /*
     * A web font is the single most common way an "offline" app still reaches
     * the internet: `@font-face` with a remote `src` is a guaranteed network
     * request on every load, and an offline phone silently falls back to a
     * different typeface — so the text reflows and nobody reports why. Station
     * declares a local system font stack instead.
     */
    expect(css).not.toMatch(/@font-face/i)
  })

  it('references no CDN or remote font host', () => {
    for (const provider of [
      'fonts.googleapis',
      'fonts.gstatic',
      'cdn.jsdelivr',
      'unpkg.com',
      'cdnjs',
      'ajax.googleapis',
      'cdn.skypack',
      'esm.sh',
    ]) {
      expect(css, `CSS references ${provider}`).not.toContain(provider)
    }
  })
})

describe('production build: the script bundle reaches nothing remote', () => {
  const jsFiles = built ? distFiles().filter((f) => f.endsWith('.js')) : []
  const raw = jsFiles.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n')

  /*
   * XML namespace URIs DO appear as `http://` strings, because the Excel export
   * pulls in an OOXML writer. They are never dereferenced: they are opaque
   * identifiers compared as strings while writing a workbook. They are removed
   * before the remote-host scan — narrowly, by host, so a genuine remote call
   * cannot hide behind the exception.
   */
  const bundle = raw.replace(
    /https?:\/\/(?:schemas\.openxmlformats\.org|purl\.oclc\.org|schemas\.microsoft\.com|docs\.oasis-open\.org|openoffice\.org|purl\.org|macVmlSchemaUri)[^\s"'`)]*/gi,
    '',
  )

  it('has a script bundle to audit', () => {
    expect(jsFiles.length, 'the build must emit JS').toBeGreaterThan(0)
  })

  it('references no CDN, remote font host, analytics or error reporter', () => {
    /*
     * This is the one check that can see INSIDE the application, because the
     * script bundle is what the phone executes. A CDN import, a telemetry beacon
     * or an error-reporting `send()` added to any dependency is invisible to
     * every other suite here: nothing else ever loads a page.
     *
     * Every entry is matched as a HOST or a full call, never as a bare product
     * name. A bare word produces false alarms against the bundle's own contents:
     * `amplitude` in particular occurs in an `Intl` locale-name list that
     * ships inside a dependency, which has nothing to do with analytics. The
     * signal is the endpoint a phone would actually dial.
     */
    for (const host of [
      // CDNs and remote module hosts
      'cdn.jsdelivr',
      'unpkg.com',
      'cdnjs.cloudflare.com',
      'cdn.skypack',
      'esm.sh',
      'esm.run',
      'deno.land',
      // Remote font hosts
      'fonts.googleapis',
      'fonts.gstatic',
      'use.typekit.net',
      // Image CDNs — the one Station genuinely used, for public metadata
      'res.cloudinary',
      // Analytics and telemetry endpoints
      'google-analytics',
      'googletagmanager',
      'analytics.google',
      'api.amplitude.io',
      'api.segment.io',
      'cdn.segment.com',
      'api.posthog.com',
      'api.mixpanel.com',
      'api.intercom.io',
      'client.mixpanel.com',
      'script.hotjar.com',
      'connect.facebook.net',
      // Error and crash reporting
      'sentry.io',
      'ingest.sentry',
      'browser-intake-datadoghq',
      'api.rollbar.com',
      'o1.ingest.rollbar',
    ]) {
      expect(bundle, `the bundle references ${host}`).not.toContain(host)
    }

    // The call sites themselves, which would appear even against a host that is
    // assembled at runtime from parts.
    for (const call of ['gtag(', 'dataLayer.push', 'Sentry.init', 'bugsnagClient']) {
      expect(bundle, `the bundle calls ${call}`).not.toContain(call)
    }
  })

  it('emits no module import from a remote URL', () => {
    /*
     * A static `import "https://…"` or a dynamic `import("https://…")` is a hard
     * dependency the browser must fetch before the module can evaluate, so it
     * stops the application booting at all offline — the worst possible failure,
     * because there is no partial experience, only a blank page.
     */
    expect(bundle).not.toMatch(/import\s*\(?\s*["']https?:\/\//i)
    expect(bundle).not.toMatch(/\bfrom\s*["']https?:\/\//i)
  })

  it('opens no WebSocket or EventSource to a remote origin', () => {
    // A phone on a LAN with no internet leaves these pending until timeout.
    // There are none in Station: every call is a same-origin `POST /api/v1/cmd`.
    for (const url of [
      ...bundle.matchAll(/new\s+(?:WebSocket|EventSource)\s*\(\s*["'`]([^"'`]+)/gi),
    ].map((m) => m[1])) {
      expect(url, `a live connection to ${url} is not offline-safe`).not.toMatch(
        /^(https?|wss?):\/\//i,
      )
    }
  })

  it('addresses no hardcoded host, so the API stays on the page origin', () => {
    /*
     * The one network call the application may make is to itself. `ipc.ts` builds
     * every command URL from the relative `/api/v1/cmd` prefix, so the resolved
     * origin is whatever the phone loaded the page from — the Station listener,
     * and nothing else. If that became absolute, the LAN build would depend on
     * a hostname that may not resolve offline.
     */
    expect(bundle).not.toMatch(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i)
  })
})

describe('the LAN listener can serve every file it must', () => {
  const manifest = built ? readFileSync(join(ROOT, 'public/site.webmanifest'), 'utf8') : ''

  it('ships exactly the root assets web::ROOT_ASSETS names', () => {
    /*
     * `web::ROOT_ASSETS` is a CLOSED list, deliberately: serving whatever sits
     * at the root of `dist/` would republish every bundled file by path. The
     * price of that safety is that a file is unreachable on the LAN unless it is
     * listed there — silently, because nothing fails until a phone asks.
     *
     * Both directions are pinned: each of the three must be emitted, and nothing
     * else may sit at the root, so neither side can quietly diverge.
     */
    const assets = distFiles().filter((f) => !f.includes('/') && f !== 'index.html')
    expect(assets.length, 'the build must emit the root assets').toBeGreaterThan(0)
    for (const required of ['station-cafe.png', 'station-print.png', 'site.webmanifest']) {
      expect(assets, `${required} must be emitted`).toContain(required)
    }
    expect(assets.sort()).toEqual(['site.webmanifest', 'station-cafe.png', 'station-print.png'])
  })

  it('ships a manifest whose icons and start_url the listener can serve', () => {
    /*
     * The browser fetches `/site.webmanifest` and then each icon it names, over
     * the LAN, and an installed app opens `start_url`. All three must be
     * satisfiable by the listener, or installing Station on a phone silently
     * produces a broken icon or a dead start.
     */
    const parsed = JSON.parse(manifest) as {
      start_url?: string
      scope?: string
      icons?: { src?: string }[]
    }
    for (const icon of parsed.icons ?? []) {
      const src = icon.src ?? ''
      expect(src, 'a manifest icon must be root-relative').toMatch(/^\/[\w.-]+$/)
      expect(existsSync(join(DIST, src.replace(/^\//, ''))), `${src} is not in dist/`).toBe(true)
    }
    expect(parsed.start_url).toBeTruthy()
    expect(parsed.start_url).toMatch(/^\/[\w/-]*$/)
    expect(parsed.scope).toBe('/')
  })

  it('names a start_url the SPA fallback answers with the shell', () => {
    // `web::route_with` sends any extensionless unknown path to the shell, so
    // this is the property that makes a PWA launch and a browser refresh on a
    // deep link behave identically.
    expect(manifest).toContain('"start_url": "/pos"')
  })
})

describe('the QR target is reachable by another device, not just the till', () => {
  it('encodes a LAN-reachable URL and never a loopback one', () => {
    /*
     * The QR encodes `http://<lan-ip>:<port>/` and is scanned by a PHONE. A
     * loopback address in that payload resolves to the phone itself, so the code
     * would scan perfectly and reach nothing — the exact failure
     * `network::address` refuses to allow, asserted here from the consumer's
     * side so the QR contract is covered with the rest of the LAN path.
     */
    const qr = readFileSync(join(ROOT, 'src-tauri/src/network/qr.rs'), 'utf8')
    // The one URL the module builds is assembled from host and port alone, so no
    // credential can ever be concatenated into the payload.
    expect(qr).toContain('fn access_url(host: &str, port: u16) -> String')
    expect(qr).toContain('format!("http://{host}:{port}{ACCESS_PATH}")')

    // No loopback or wildcard may appear in the PRODUCTION half of the module;
    // the tests below are allowed to, and are how the refusal is demonstrated.
    // Comments are stripped first, because the module's own documentation
    // necessarily NAMES `127.0.0.1` to explain why it refuses it — matching the
    // prose would assert the opposite of the intent.
    const testModule = qr.indexOf('#[cfg(test)]')
    expect(testModule, 'qr.rs must keep its tests behind #[cfg(test)]').toBeGreaterThan(0)
    const production = stripRustComments(qr.slice(0, testModule))
    expect(production).not.toMatch(/127\.0\.0\.1/)
    expect(production).not.toMatch(/localhost/)
    expect(production).not.toMatch(/0\.0\.0\.0/)
  })
})
