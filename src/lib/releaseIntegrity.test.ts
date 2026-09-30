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
import releasingDoc from '../../docs/RELEASING.md?raw'
import libRs from '../../src-tauri/src/lib.rs?raw'
import capabilitiesRaw from '../../src-tauri/capabilities/default.json?raw'
import updateApiSource from '../services/updateApi.ts?raw'
import updateCardSource from '../features/dev/ApplicationUpdatesCard.tsx?raw'

const tauriConf = JSON.parse(tauriConfRaw) as {
  version: string
  app: { security: { csp: string | null } }
  bundle: { targets: string[] | 'all'; createUpdaterArtifacts?: boolean }
  plugins?: { updater?: { pubkey: string; endpoints: string[] } }
}
const csp = tauriConf.app.security.csp

/**
 * The frontend updater surface, read as raw text like every other source here.
 *
 * Comments are stripped before the behavioural assertions: prose in this
 * repository deliberately NAMES the things it must not do ("never route through
 * `call()`", "never fetch a `.sig`"), so asserting against raw text would match
 * the explanation of the rule instead of the code that could break it.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** base64(text) -> UTF-8 text, through the platform primitives already used here. */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const updateService = codeOnly(updateApiSource)
const updateCard = codeOnly(updateCardSource)

/** base64(sha256(text)) — the exact form a CSP `script-src` hash uses. */
async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
}

/** Every inline (non-`src`) <script> in the document, in document order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

/**
 * A CSP hash is computed over exact bytes, so the content hashed here must be
 * the content that actually ships. The repository stores `index.html` with LF
 * endings (enforced by `.gitattributes`), and the release pipeline therefore
 * always builds a LF `dist/index.html`; normalising to LF makes this check
 * assert that canonical contract instead of whatever line endings a given
 * checkout happened to produce. It does NOT weaken the assertion: any edit to
 * the bootstrap — on any platform — still changes the hash and still fails.
 * The real cross-platform guarantee is the `.gitattributes` rule; this keeps
 * the test deterministic on top of it.
 */
function canonicalize(html: string): string {
  return html.replace(/\r\n/g, '\n')
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
    const hashes = await Promise.all(inlineScripts(canonicalize(indexHtml)).map(sha256Base64))
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

/**
 * Updater BUILD infrastructure. The update channel is configured and signed;
 * the update UI, polling and install flow are deliberately NOT implemented
 * yet. These tests protect the part that exists, because each of these values
 * is silent when wrong: a bad pubkey makes every update fail verification on
 * a manager's PC, and a missing pubkey makes the app abort at startup.
 */
describe('updater build infrastructure', () => {
  const updater = tauriConf.plugins?.updater

  it('configures the updater with a public key', () => {
    // tauri-plugin-updater ABORTS AT STARTUP without this config. The pubkey
    // is the PUBLIC half and is safe to commit; it cannot forge a signature.
    expect(updater).toBeDefined()
    expect(typeof updater?.pubkey).toBe('string')
    expect(updater?.pubkey.length).toBeGreaterThan(40)
  })

  it('uses only fixed https update endpoints', () => {
    // A runtime-configurable update URL would let any host serve an update
    // manifest. The endpoint is compiled in and points at the project owner.
    expect(Array.isArray(updater?.endpoints)).toBe(true)
    expect(updater?.endpoints.length).toBeGreaterThan(0)
    for (const endpoint of updater?.endpoints ?? []) {
      expect(endpoint).toMatch(/^https:\/\//)
    }
    expect(updater?.endpoints.join(' ')).toContain('bassim-ghaly-14/station-cafe')
  })

  it('commits no private signing key', () => {
    // The private key must exist ONLY as the CI secret
    // TAURI_SIGNING_PRIVATE_KEY. A minisign secret key is recognisable by
    // its header; if one ever appears in the repo, updates could be forged
    // by anyone with repository read access.
    const committed = [tauriConfRaw, workflow, cargoToml, packageRaw].join('\n')
    expect(committed).not.toContain('minisign secret key')
    expect(committed).not.toContain('untrusted comment: minisign secret key')
  })

  it('registers the updater plugin in Rust', () => {
    // Config alone does nothing; the plugin must be registered for the
    // channel to exist.
    expect(libRs).toContain('tauri_plugin_updater::Builder::new().build()')
  })

  it('grants exactly the updater permissions the signed-update flow needs', () => {
    // `updater:default` would also hand the webview download and install as
    // blanket capability, which is not what the flow is allowed to reach. The
    // two permissions below are the whole updater surface: check for the manual
    // button, download-and-install for the confirmed install path.
    //
    // The permission set is asserted, not merely spot-checked: a future
    // `updater:default` — the single most likely way this regresses — fails
    // here rather than shipping ambient install capability to a POS.
    const caps = JSON.parse(capabilitiesRaw) as { permissions: string[] }
    expect(caps.permissions).toContain('updater:allow-check')
    expect(caps.permissions).toContain('updater:allow-download-and-install')
    expect(caps.permissions).not.toContain('updater:default')

    const updaterPermissions = caps.permissions.filter((p) => p.startsWith('updater:'))
    expect(updaterPermissions.sort()).toEqual([
      'updater:allow-check',
      'updater:allow-download-and-install',
    ])
    // No deny entries either: a paired deny would silently disable the flow.
    for (const p of updaterPermissions) {
      expect(p).not.toMatch(/^updater:deny-/)
    }
  })

  it('registers the process plugin so the update flow can relaunch Station', () => {
    // Installing an update ends the process on Windows, and the manager must
    // come back to the new version without hunting for a shortcut. That relaunch
    // goes through tauri-plugin-process, so the plugin must be registered next
    // to the updater — not merely available as a dependency.
    expect(libRs).toContain('tauri_plugin_process::init()')
    // And the capability that authorises it from the webview.
    const caps = JSON.parse(capabilitiesRaw) as { permissions: string[] }
    expect(caps.permissions).toContain('process:allow-restart')
    // `allow-exit` is not granted: Station leaves the process only through the
    // NSIS installer, never through a webview-triggered exit.
    expect(caps.permissions).not.toContain('process:allow-exit')

    const cargoTomlDeps = cargoToml.slice(cargoToml.indexOf('[dependencies]'))
    expect(cargoTomlDeps).toContain('tauri-plugin-process')
  })

  it('grants no broad filesystem, shell or http capability', () => {
    // The update channel needs none of these. A POS that handles money and
    // customer data must not hand the webview ambient filesystem or network
    // access as a side effect of being updatable.
    const caps = JSON.parse(capabilitiesRaw) as { permissions: string[] }
    for (const p of caps.permissions) {
      expect(p).not.toMatch(/^fs:/)
      expect(p).not.toMatch(/^shell:/)
      expect(p).not.toMatch(/^http:/)
    }
  })

  it('produces signed updater artifacts in the release build', () => {
    // Without this, the release workflow publishes an installer that no
    // client can ever update to. With it and no key present, the build FAILS
    // rather than silently publishing an unsigned update.
    expect(tauriConf.bundle.createUpdaterArtifacts).toBe(true)
  })

  it('wires the signing secrets through CI only', () => {
    // The key reaches the build as a repository secret and never as a file
    // in the tree.
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.')
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.')
  })

  it('fingerprints each signing layer before building', () => {
    // Tauri reports a missing key, a wrong key, a non-base64 key, a lost
    // comment line and a rejected password with ONE indistinguishable error
    // ("failed to decode secret key"). That is how this pipeline failed with
    // no way to tell which layer broke. The pre-build diagnostic must
    // therefore still exist and still distinguish those layers, or the next
    // regression is just as opaque.
    expect(workflow).toContain('Verify updater signing key')
    for (const layer of ['LAYER 1', 'LAYER 2', 'LAYER 3', 'LAYER 4', 'LAYER 5']) {
      expect(workflow).toContain(layer)
    }
    // The fingerprint is a checksum of the deployed key, so a wrong-but-valid
    // key is caught before the (slow) Windows build rather than after.
    expect(workflow).toMatch(/EXPECTED_KEY_SHA256=[0-9a-f]{64}/)
  })

  it('never echoes a signing secret into the CI log', () => {
    // The diagnostic exists to be safe to run on every build, so it must stay
    // safe: lengths, a one-way SHA-256 and booleans only. Echoing the key or
    // the password would put the updater signing key in a build log, which is
    // world-readable for public repositories.
    const echoLines = workflow
      .split('\n')
      .filter((l) => /^\s*echo\b/.test(l) || /\becho\b/.test(l))
      .join('\n')
    // No echo may reference the secret variables or the decoded key material.
    expect(echoLines).not.toMatch(/\$TAURI_SIGNING_PRIVATE_KEY_PASSWORD\b/)
    expect(echoLines).not.toMatch(/echo[^#]*\$\{?TAURI_SIGNING_PRIVATE_KEY\}?["']?\s*$/)
    expect(echoLines).not.toMatch(/echo[^#]*\$decoded/)
    expect(echoLines).not.toMatch(/echo[^#]*\$key\b/)
  })

  it('documents the encrypted-key empty password accurately', () => {
    // The key is in minisign's ENCRYPTED format with an EMPTY password, so
    // the password secret must be ABSENT. The previous wording told the
    // operator to run `gh secret set ... --body ''`, which GitHub silently
    // discards -- leaving them to set a real password, which is exactly the
    // 4-character value that broke the release build. That instruction must
    // not come back; the fix is `gh secret delete`.
    expect(releasingDoc).toContain('gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
    expect(releasingDoc).not.toMatch(/gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD/)
    expect(releasingDoc).not.toMatch(/generated \*\*without a password\*\*/)
  })

  it('fails the build on a non-empty signing password', () => {
    // A wrong password and a missing key produce the SAME opaque Tauri error
    // ("failed to decode secret key"), which is how a byte-perfect key plus
    // a stray password secret produced an unexplained red build. The password
    // must therefore be ASSERTED, not merely logged: this key is encrypted
    // with an empty password, so any non-empty value is wrong.
    expect(workflow).toContain('LAYER 6')
    expect(workflow).toMatch(/LAYER 6 \(wrong password\)/)
    // Fail-closed: the password layer must ABORT the job, not merely warn.
    // Scope the check to the layer's own block, so a later step's `exit 1`
    // cannot make this pass by accident.
    const afterLayer6 = workflow.slice(workflow.indexOf('LAYER 6 (wrong password)'))
    const block = afterLayer6.slice(0, afterLayer6.indexOf('\n\n'))
    expect(block).toContain('exit 1')
  })

  it('implements no custom Rust updater command', () => {
    // The frontend calls tauri-plugin-updater directly. A Station-owned
    // `check_for_update`/`install_update` command would be a SECOND route to the
    // same signed channel with its own error surface, its own auth story, and
    // its own place to accidentally become automatic. There must be exactly one
    // path to the plugin, and it is the JS API.
    expect(libRs).not.toContain('check_for_update')
    expect(libRs).not.toContain('install_update')
    expect(libRs).not.toContain('commands::updates')
  })

  it('keeps the update flow manual: no polling, timer or startup check', () => {
    // Station is offline-first. An automatic check would make a cafe's till
    // reach the internet on its own, which is exactly what the product promise
    // forbids — so the absence is asserted, not just documented.
    expect(updateService).not.toMatch(/setInterval|setTimeout/)
    // And the card never checks on mount: its only effect reads the version.
    expect(updateCard).not.toMatch(/checkForUpdate\(\)[\s\S]{0,200}useEffect/)
  })

  it('never routes updater traffic through the LAN command bridge', () => {
    // `call()` is the LAN `/api/v1/cmd` transport. An update call routed
    // through it would expose a desktop-only capability to any phone on the
    // cafe LAN and put a GitHub download on the LAN HTTP surface.
    expect(updateService).not.toMatch(/\bcall[<(]/)
    expect(updateService).not.toContain('/api/v1/cmd')
    expect(updateService).toContain("from './ipc'")
    // It imports `isDesktop` from that module and nothing else.
    expect(updateService).toMatch(/import \{ isDesktop \} from '\.\/ipc'/)
  })

  it('verifies signatures in Rust, never in the frontend', () => {
    // The plugin verifies the downloaded bundle against the compiled pubkey
    // inside Rust. A frontend re-implementation, or a hand-fetched `.sig`, would
    // be a second verification path that could disagree with the real one.
    expect(updateService).not.toContain('.sig')
    expect(updateService).not.toMatch(/minisign/i)
    expect(updateService).not.toContain('pubkey')
    expect(updateService).not.toContain('TAURI_SIGNING_PRIVATE_KEY')
    // The public key stays exactly one compiled value in one place. It decodes
    // to a minisign PUBLIC key — never a private half, which would mean anyone
    // with repository read access could forge an update.
    expect(updater?.pubkey).toBeTruthy()
    const decodedKey = decodeBase64Utf8(updater?.pubkey ?? '')
    expect(decodedKey).toContain('minisign public key')
    expect(decodedKey).not.toContain('minisign secret key')
  })

  it('exposes no signing material to the frontend', () => {
    // Belt and braces on the "no secret in the bundle" rule, across every file
    // the webview can reach.
    const frontendSources = [updateService, updateCard]
    for (const source of frontendSources) {
      expect(source).not.toContain('minisign secret key')
      expect(source).not.toContain('TAURI_SIGNING_PRIVATE_KEY')
    }
  })
})
