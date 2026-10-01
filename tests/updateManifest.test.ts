/**
 * THE UPDATE MANIFEST CONTRACT — can one release update every platform?
 *
 * This suite exercises the REAL selection logic in
 * `scripts/verify-release-manifest.mjs`, which mirrors
 * `tauri-plugin-updater`'s own `UpdaterBuilder::get_urls`. It is the same
 * module the release workflow runs against the manifest actually attached to
 * the GitHub Release, so a change that breaks platform selection fails here
 * BEFORE a release is published rather than after.
 *
 * The bug this exists for
 * -----------------------
 * `v0.1.0` shipped a green, tagged, signed release whose `latest.json` carried
 * `windows-x86_64` and `windows-x86_64-nsis` and nothing else. Windows updated
 * correctly; every Mac was told there was no build for its platform. No build
 * step failed, because the Windows job had done everything it was asked to do.
 *
 * WHY THIS FILE IS UNDER `tests/`
 * ------------------------------
 * The module under test is a Node ESM script (`scripts/`), not application
 * code. `tsconfig.app.json` withholds Node types from the bundle on purpose, so
 * this suite lives with `lanContract.test.ts` in the Node-typechecked project.
 * Nothing under `src/` imports it, so it still ships in no bundle.
 *
 * WHY IT IS NOT A MOCK
 * --------------------
 * The manifests below are the shapes `tauri-action` really emits — including
 * the exact v0.1.0 shape fetched from the live release — and `resolveTarget`
 * is the same resolver a client runs. Asserting against a fabricated
 * `{check: () => update}` stub would prove nothing about which artifact a Mac
 * actually downloads.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REQUIRED_TARGETS,
  candidateTargets,
  findManifestProblems,
  isNewerVersion,
  resolveManifestPath,
  resolveTarget,
} from '../scripts/verify-release-manifest.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-release-manifest.mjs')

const WINDOWS = { os: 'windows', arch: 'x86_64', installer: 'nsis' }
const APPLE_SILICON = { os: 'darwin', arch: 'aarch64', installer: 'app' }
const INTEL_MAC = { os: 'darwin', arch: 'x86_64', installer: 'app' }

const entry = (file: string) => ({ signature: 'c2lnbmVk', url: `https://example.test/${file}` })

/**
 * A release carrying BOTH platforms — what a correct pipeline publishes.
 *
 * The macOS keys come from a `universal-apple-darwin` build: one artifact,
 * listed under both architectures, which is exactly how `tauri-action` expands
 * a universal bundle into the manifest.
 */
const bothPlatforms = {
  version: '0.1.1',
  platforms: {
    'windows-x86_64': entry('Station.Cafe_0.1.1_x64-setup.exe'),
    'windows-x86_64-nsis': entry('Station.Cafe_0.1.1_x64-setup.exe'),
    'darwin-aarch64-app': entry('Station.Cafe_0.1.1_universal.app.tar.gz'),
    'darwin-x86_64-app': entry('Station.Cafe_0.1.1_universal.app.tar.gz'),
    'darwin-universal': entry('Station.Cafe_0.1.1_universal.app.tar.gz'),
  },
}

/**
 * The REAL v0.1.0 manifest, with the signatures truncated.
 *
 * Fetched from `releases/latest/download/latest.json`. This is the artifact
 * that made macOS report "no release published for this system", so keeping it
 * as a fixture means the regression cannot be reintroduced silently.
 */
const windowsOnlyV010 = {
  version: '0.1.0',
  platforms: {
    'windows-x86_64': entry('Station.Cafe_0.1.0_x64-setup.exe'),
    'windows-x86_64-nsis': entry('Station.Cafe_0.1.0_x64-setup.exe'),
  },
}

describe('updater target resolution', () => {
  it('asks for the bundle-specific key first, then the bare one', () => {
    // This ordering IS the plugin's contract: a more specific artifact wins, and
    // the bare `{os}-{arch}` is the fallback. Reversing it would make a Mac
    // download the wrong file on a release that carries both shapes.
    expect(candidateTargets(WINDOWS)).toEqual(['windows-x86_64-nsis', 'windows-x86_64'])
    expect(candidateTargets(APPLE_SILICON)).toEqual(['darwin-aarch64-app', 'darwin-aarch64'])
    expect(candidateTargets(INTEL_MAC)).toEqual(['darwin-x86_64-app', 'darwin-x86_64'])
  })

  it('selects the Windows artifact on Windows', () => {
    const resolved = resolveTarget(bothPlatforms, WINDOWS)
    expect(resolved?.key).toBe('windows-x86_64-nsis')
    expect(resolved?.url).toContain('setup.exe')
  })

  it('selects the macOS artifact on Apple Silicon', () => {
    const resolved = resolveTarget(bothPlatforms, APPLE_SILICON)
    expect(resolved?.key).toBe('darwin-aarch64-app')
    expect(resolved?.url).toContain('.app.tar.gz')
  })

  it('selects the macOS artifact on an Intel Mac', () => {
    const resolved = resolveTarget(bothPlatforms, INTEL_MAC)
    expect(resolved?.key).toBe('darwin-x86_64-app')
    expect(resolved?.url).toContain('.app.tar.gz')
  })

  it("never selects another platform's artifact", () => {
    // The whole point of a keyed manifest: a Mac must never be offered the
    // Windows installer, which it cannot run, and a Windows client must never
    // be offered a .app.tar.gz.
    expect(resolveTarget(bothPlatforms, WINDOWS)?.url).not.toContain('.app.tar.gz')
    expect(resolveTarget(bothPlatforms, APPLE_SILICON)?.url).not.toContain('.exe')
    expect(resolveTarget(bothPlatforms, INTEL_MAC)?.url).not.toContain('.exe')
    // And a Windows-only release must simply not resolve for a Mac.
    expect(resolveTarget(windowsOnlyV010, APPLE_SILICON)).toBeNull()
    expect(resolveTarget(windowsOnlyV010, INTEL_MAC)).toBeNull()
  })

  it('falls back to {os}-{arch} when a release has no bundle-suffixed key', () => {
    // Some producers publish only the bare key. The plugin accepts it, so the
    // gate must not reject a release a real client could install from.
    const bare = {
      version: '0.2.0',
      platforms: {
        'windows-x86_64': entry('app.exe'),
        'darwin-aarch64': entry('app.tar.gz'),
        'darwin-x86_64': entry('app.tar.gz'),
      },
    }
    expect(resolveTarget(bare, WINDOWS)?.key).toBe('windows-x86_64')
    expect(resolveTarget(bare, APPLE_SILICON)?.key).toBe('darwin-aarch64')
    expect(findManifestProblems(bare)).toEqual([])
  })
})

describe('release manifest gate', () => {
  it('accepts a release that can update every shipped platform', () => {
    expect(findManifestProblems(bothPlatforms)).toEqual([])
  })

  it('rejects the published v0.1.0 manifest for exactly the macOS targets', () => {
    // THE REGRESSION. Windows resolved; both Mac architectures did not. A gate
    // that let this through is why a Mac was told there was no release.
    const problems = findManifestProblems(windowsOnlyV010)
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toContain('darwin-aarch64')
    expect(problems.join('\n')).toContain('darwin-x86_64')
    // Every complaint is about a Mac; Windows itself is never named as
    // failing (it appears only inside the list of keys the release does carry).
    expect(problems.map((p) => p.split(':')[0])).toEqual(['darwin-aarch64', 'darwin-x86_64'])
    // And it says which keys it tried, so the failure names its own cause.
    expect(problems.join('\n')).toContain('darwin-aarch64-app')
  })

  it('requires every shipped platform, not just one of them', () => {
    const macOnly = {
      version: '0.1.1',
      platforms: {
        'darwin-aarch64-app': entry('Station.app.tar.gz'),
        'darwin-x86_64-app': entry('Station.app.tar.gz'),
      },
    }
    // Fixing macOS must not be possible by dropping Windows.
    const problems = findManifestProblems(macOnly)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('windows-x86_64')
  })

  it('requires BOTH macOS architectures, not one universal guess', () => {
    const oneMac = {
      version: '0.1.1',
      platforms: {
        'windows-x86_64-nsis': entry('setup.exe'),
        'darwin-aarch64-app': entry('Station.app.tar.gz'),
      },
    }
    const problems = findManifestProblems(oneMac)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('darwin-x86_64')
  })

  it('rejects a malformed manifest instead of reading it as "no update"', () => {
    expect(findManifestProblems(null)).toEqual(['the manifest is not a JSON object'])
    expect(findManifestProblems({ version: '0.1.1' })[0]).toContain('no `platforms` object')
    expect(findManifestProblems({ version: '0.1', platforms: {} })[0]).toContain(
      'not a plain MAJOR.MINOR.PATCH version',
    )
  })

  it('rejects an unsigned artifact', () => {
    // An empty signature is not a signature: the client refuses the download at
    // verification time, so the artifact is as unusable as a missing one — and
    // unlike a missing one it is invisible in the release listing.
    const unsigned = {
      version: '0.1.1',
      platforms: {
        'windows-x86_64-nsis': { signature: '   ', url: entry('setup.exe').url },
        'darwin-aarch64-app': entry('Station.app.tar.gz'),
        'darwin-x86_64-app': entry('Station.app.tar.gz'),
      },
    }
    const problems = findManifestProblems(unsigned)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('empty signature')
  })

  it('rejects a macOS entry that points at a .dmg', () => {
    // The updater installs a `.app.tar.gz`. A `.dmg` is the manual-install path;
    // wiring it into the manifest would make the client try to unpack an image.
    const dmg = {
      version: '0.1.1',
      platforms: {
        'windows-x86_64-nsis': entry('setup.exe'),
        'darwin-aarch64-app': entry('Station.dmg'),
        'darwin-x86_64-app': entry('Station.app.tar.gz'),
      },
    }
    const problems = findManifestProblems(dmg)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('.dmg')
  })

  it('names every shipped platform explicitly', () => {
    // The required list is the release contract: Windows x64, Apple Silicon and
    // Intel. A platform silently dropped from here is one no client can update.
    expect(REQUIRED_TARGETS).toEqual([WINDOWS, APPLE_SILICON, INTEL_MAC])
  })
})

describe('release version comparison', () => {
  it('detects the next patch release as newer', () => {
    // The scenario this whole flow exists for: a v0.1.0 client must see v0.1.1.
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true)
    expect(isNewerVersion('0.1.1', '0.1.1')).toBe(false)
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(false)
  })

  it('compares numerically, not lexicographically', () => {
    // The failure a string comparison hides: "0.1.10" sorts BELOW "0.1.9" as
    // text, so a released 0.1.10 would be invisible to every client on 0.1.9.
    expect(isNewerVersion('0.1.9', '0.1.10')).toBe(true)
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(false)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
  })

  it('refuses to compare anything that is not a release version', () => {
    // A prerelease or a malformed version must never be treated as "newer";
    // that would offer an install that cannot succeed.
    for (const value of ['0.1', 'v0.1.1', '0.1.1-beta', '', 'latest']) {
      expect(isNewerVersion('0.1.0', value)).toBe(false)
      expect(isNewerVersion(value, '0.1.1')).toBe(false)
    }
  })
})

/** Run the CLI exactly as the release workflow does and capture its output. */
function runCli(args: string[], cwd = REPO_ROOT) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

/** A throwaway manifest inside a temp root, cleaned up after the callback. */
function withManifestFile(contents: string, run: (file: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-manifest-'))
  const file = path.join(dir, 'latest.json')
  fs.writeFileSync(file, contents)
  try {
    run(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('release manifest path policy', () => {
  it('rejects a missing or empty path', () => {
    expect(() => resolveManifestPath(undefined)).toThrow()
    expect(() => resolveManifestPath('')).toThrow()
    expect(() => resolveManifestPath('   ')).toThrow()
  })

  it('accepts a path inside the repository and inside a temp directory', () => {
    // The release workflow runs from the checkout root and validates the file it
    // downloaded into $RUNNER_TEMP, so BOTH of these must keep working.
    expect(resolveManifestPath(path.join(REPO_ROOT, 'scripts', 'anything.json'))).toContain(
      path.join('scripts', 'anything.json'),
    )
    withManifestFile('{}', (file) => {
      expect(resolveManifestPath(file)).toBe(fs.realpathSync(file))
    })
  })

  it('rejects traversal out of the allowed roots', () => {
    // Synthetic roots keep the assertions independent of a developer path.
    const roots = [path.resolve(path.sep, 'srv', 'station')]
    expect(() =>
      resolveManifestPath(path.resolve(path.sep, 'srv', 'station', '..', 'etc'), roots),
    ).toThrow()
    expect(() => resolveManifestPath(path.join('..', '..', 'etc', 'passwd'), roots)).toThrow()
  })

  it('rejects an absolute path outside the allowed roots', () => {
    const roots = [path.resolve(path.sep, 'srv', 'station')]
    expect(() => resolveManifestPath(path.resolve(path.sep, 'etc', 'shadow'), roots)).toThrow()
  })

  it('rejects a sibling directory that merely shares a name prefix', () => {
    // `/srv/station-secrets` is NOT inside `/srv/station`. A `startsWith`
    // containment check would let this through; `path.relative` does not.
    const roots = [path.resolve(path.sep, 'srv', 'station')]
    expect(() =>
      resolveManifestPath(path.resolve(path.sep, 'srv', 'station-secrets', 'latest.json'), roots),
    ).toThrow()
  })

  it('rejects a Windows-shaped path on a POSIX host', () => {
    // `path.resolve` would read `C:\...` as a relative FILENAME here, so the
    // foreign-separator case has to be rejected rather than normalised.
    if (path.sep !== '/') return
    expect(() => resolveManifestPath(String.raw`C:\Users\someone\latest.json`)).toThrow()
  })
})
describe('release manifest CLI output safety', () => {
  it('fails with exit 2 and leaks no path when the argument is missing', () => {
    const { status, err } = runCli([])
    expect(status).toBe(2)
    expect(err).toContain('usage: node scripts/verify-release-manifest.mjs')
    expect(err).not.toContain(REPO_ROOT)
  })

  it('fails with exit 2 when the path escapes the allowed roots', () => {
    const { status, err } = runCli(['../../../../../../etc/hosts'])
    expect(status).toBe(2)
    expect(err).not.toContain('/etc/hosts')
    expect(err).not.toContain(REPO_ROOT)
  })

  it('fails with exit 1 without leaking the path or the raw JSON error', () => {
    withManifestFile('{ this is not json', (file) => {
      const { status, out, err } = runCli([file])
      expect(status).toBe(1)
      expect(err).toContain('error: unable to read the release manifest')
      expect(err).not.toContain(file)
      expect(err).not.toContain('this is not json')
      expect(`${out}${err}`).not.toContain(os.tmpdir())
    })
  })

  it('never prints manifest URLs or signatures', () => {
    // A URL carrying a token is exactly what a leaked CI log would expose.
    const token = 'super-secret-token'
    const manifest = {
      version: '0.1.1',
      platforms: {
        'windows-x86_64-nsis': {
          signature: 'c2lnbmVk',
          url: `https://example.test/setup.exe?token=${token}`,
        },
        'darwin-aarch64-app': entry('Station.app.tar.gz'),
        'darwin-x86_64-app': entry('Station.app.tar.gz'),
      },
    }
    withManifestFile(JSON.stringify(manifest), (file) => {
      const { status, out, err } = runCli([file])
      expect(status).toBe(0)
      expect(out).toContain('windows-x86_64-nsis -> resolved')
      expect(out).toContain('darwin-aarch64-app -> resolved')
      expect(`${out}${err}`).not.toContain(token)
      expect(`${out}${err}`).not.toContain('example.test')
      expect(`${out}${err}`).not.toContain('c2lnbmVk')
    })
  })

  it('does not echo an unvalidated version or arbitrary platform keys', () => {
    const injected = 'https://evil.test/?token=abc'
    const manifest = {
      version: injected,
      platforms: { [`${injected} ${'x'.repeat(200)}`]: entry('setup.exe') },
    }
    withManifestFile(JSON.stringify(manifest), (file) => {
      const { status, err } = runCli([file])
      expect(status).toBe(1)
      expect(err).toContain('is not updatable everywhere')
      expect(err).not.toContain(injected)
      expect(err).not.toContain('evil.test')
      expect(err).toContain('(unvalidated version)')
      expect(err).toContain('`version` is not a plain MAJOR.MINOR.PATCH version')
    })
  })

  it('still fails a windows-only release and passes a complete one', () => {
    withManifestFile(JSON.stringify(windowsOnlyV010), (file) => {
      const { status, err } = runCli([file])
      expect(status).toBe(1)
      expect(err).toContain('darwin-aarch64')
    })
    withManifestFile(JSON.stringify(bothPlatforms), (file) => {
      const { status, out } = runCli([file])
      expect(status).toBe(0)
      expect(out).toContain('release manifest ok: version 0.1.1')
    })
  })

  it('reports the manifest keys it carries in a deterministic order', () => {
    // A release gate must be byte-identical run to run.
    const first = findManifestProblems(windowsOnlyV010).join('\n')
    for (let i = 0; i < 5; i += 1) {
      expect(findManifestProblems(windowsOnlyV010).join('\n')).toBe(first)
    }
    expect(first).toContain('`windows-x86_64`, `windows-x86_64-nsis`')
  })

  it('bounds how many platform keys a diagnostic will print', () => {
    const platforms: Record<string, unknown> = {}
    for (let i = 0; i < 40; i += 1) platforms[`target-${i}`] = entry('setup.exe')
    const problem = findManifestProblems({ version: '0.1.1', platforms })[0]
    expect(problem).toContain('(+28 more)')
  })
})
