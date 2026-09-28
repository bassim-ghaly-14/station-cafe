/**
 * Release integrity — the two things that break a Windows release in
 * production while every local check still passes.
 *
 * 1. THE CSP HASH. The theme bootstrap in `index.html` is an inline script,
 *    and the production Content-Security-Policy authorises it by sha256 hash
 *    rather than by opening `script-src` to `'unsafe-inline'`. That is a real
 *    security control and also a real foot-gun: edit the bootstrap and the
 *    hash stops matching, and the app renders a BLANK WINDOW on a manager's
 *    PC — with no error from the build and no failing test unless something
 *    checks. This file makes that a local, CI-visible failure.
 *
 * 2. VERSION DRIFT. The installer filename, the release tag and the updater
 *    manifest version all derive from a number declared in three files.
 *    Nothing forces them to agree, and a drift is not cosmetic: the updater
 *    compares the manifest version against the running app's version, so a
 *    mismatch can make a real update invisible to every client.
 *
 * These files are read as raw text through Vite rather than with `node:fs`,
 * so the app bundle's type boundary (no Node APIs under `src/`) is kept.
 */
import { describe, expect, it } from 'vitest'
import indexHtml from '../../index.html?raw'
import tauriConfRaw from '../../src-tauri/tauri.conf.json?raw'
import packageRaw from '../../package.json?raw'
import cargoToml from '../../src-tauri/Cargo.toml?raw'
import workflow from '../../.github/workflows/windows-build.yml?raw'

const tauriConf = JSON.parse(tauriConfRaw) as {
  version: string
  app: { security: { csp: string | null } }
  bundle: { targets: string[] | 'all' }
}
const csp = tauriConf.app.security.csp

/** base64(sha256(text)) — the exact form a CSP `script-src` hash uses. */
async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

/** Every inline (non-`src`) <script> in the document, in document order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

describe('production Content-Security-Policy', () => {
  it('is configured', () => {
    // A null policy disables CSP entirely. Station is a local, offline POS
    // and needs none of the web's remote origins.
    expect(csp).toBeTruthy()
    expect(csp).not.toBeNull()
  })

  it('authorises every inline script in index.html by hash', async () => {
    // A hash-pinned inline script is allowed; an UNlisted one is blocked,
    // which breaks the app at runtime with no local build error. This is
    // exactly the failure a future index.html edit would cause.
    const hashes = await Promise.all(inlineScripts(indexHtml).map(sha256Base64))
    expect(hashes.length).toBeGreaterThan(0)
    for (const hash of hashes) {
      expect(csp).toContain(`sha256-${hash}`)
    }
  })

  it('does not open script-src to unsafe-inline', () => {
    // The theme bootstrap is the only inline script and it is hash-pinned,
    // so 'unsafe-inline' would add risk without adding capability.
    const scriptSrc = csp?.split(';').find((d) => d.trim().startsWith('script-src'))
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })

  it('loads no remote origin', () => {
    // Station is offline-first and self-contained: a remote http(s) source
    // would be a dependency the app cannot honour on a cafe LAN with no
    // internet. `http://ipc.localhost` is a LOOPBACK origin, not a remote
    // one — it is the Tauri IPC transport and is required.
    expect(csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/)
  })

  it('still permits the Tauri IPC transport', () => {
    // Commands travel over the custom IPC protocol. Without it every backend
    // call fails and the app cannot load any data.
    expect(csp).toContain('ipc:')
    expect(csp).toContain('http://ipc.localhost')
  })

  it('permits the blob and data images used by report export', () => {
    // PNG export renders a canvas to a blob: URL. Restricting these breaks
    // reporting rather than improving security.
    const imgSrc = csp?.split(';').find((d) => d.trim().startsWith('img-src'))
    expect(imgSrc).toContain('blob:')
    expect(imgSrc).toContain('data:')
  })
})

describe('release version consistency', () => {
  it('declares one version across package.json, Cargo.toml and tauri.conf.json', () => {
    const pkgVersion = (JSON.parse(packageRaw) as { version: string }).version
    const cargoVersion = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]

    // The installer filename, the release tag and the updater manifest all
    // derive from this number; a drift here makes updates invisible.
    expect(cargoVersion).toBe(pkgVersion)
    expect(tauriConf.version).toBe(pkgVersion)
  })

  it('restricts the Windows release to the NSIS target the updater supports', () => {
    // The Tauri updater signs and applies NSIS only. Shipping MSI as well
    // would publish an artifact no client could ever update to, and would
    // pull the WiX toolchain into every release for nothing.
    //
    // This is asserted on the WORKFLOW, not on `bundle.targets`: that key is
    // shared with the macOS developer build (`pnpm build:app`), where "nsis"
    // is not a valid target, so it must stay "all" there. The narrowing is
    // applied per-platform at release time.
    expect(workflow).toContain('--bundles nsis')
    expect(tauriConf.bundle.targets).toBe('all')
  })

  it('publishes a real release only for a version tag', () => {
    // Otherwise every push to main would overwrite the published v<version>
    // release, and the updater would serve a moving target that no client
    // could pin to.
    expect(workflow).toContain("releaseDraft: ${{ github.ref_type != 'tag' }}")
  })
})
