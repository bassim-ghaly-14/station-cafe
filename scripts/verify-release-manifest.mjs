/**
 * Release manifest gate — can this published release update EVERY platform
 * Station ships?
 *
 * WHY THIS EXISTS
 * ---------------
 * A GitHub Release can be green, tagged, signed and still be unable to update
 * half its users. The updater endpoint serves ONE `latest.json` whose
 * `platforms` object is keyed by target string, and the client picks exactly
 * one key. A release whose manifest carries only `windows-x86_64-nsis` — which
 * is precisely what this repository published for v0.1.0 — is a fully
 * successful release that no Mac can install. Nothing in the build fails: the
 * Windows job did everything it was asked to do.
 *
 * So this script reads the manifest that is ACTUALLY attached to the release
 * and asks the question a client will ask, for each shipped platform.
 *
 * THE SELECTION RULE IS NOT GUESSED
 * ---------------------------------
 * It mirrors `tauri-plugin-updater`'s `UpdaterBuilder::get_urls`: build the
 * candidate list `{os}-{arch}-{bundle_type}` then `{os}-{arch}`, and take the
 * first key present in `platforms`. The bundle type is `app` on macOS and
 * `nsis` on Windows, which is why a Windows manifest and a macOS manifest are
 * not interchangeable and why one release needs both.
 *
 * It is a READ-ONLY audit. It never edits the manifest, never writes a
 * fallback entry and never weakens a signature: a manifest that cannot update a
 * platform must fail the release, not be patched into looking complete.
 *
 * Usage: node scripts/verify-release-manifest.mjs <path-to-latest.json>
 */
import fs from 'node:fs'

/**
 * Every platform a Station release must be able to update.
 *
 * `installer` is the Tauri bundle type the client appends to the target string
 * on that OS. `aarch64` is Apple Silicon, `x86_64` is Intel: the universal
 * macOS build serves both from one artifact, and both keys must resolve.
 */
export const REQUIRED_TARGETS = [
  { os: 'windows', arch: 'x86_64', installer: 'nsis' },
  { os: 'darwin', arch: 'aarch64', installer: 'app' },
  { os: 'darwin', arch: 'x86_64', installer: 'app' },
]

/**
 * The keys the updater would try, in the order it tries them.
 *
 * Mirrors `get_urls` in tauri-plugin-updater: the bundle-specific key wins, and
 * `{os}-{arch}` is the fallback for a platform distributed without a bundle
 * suffix.
 */
export function candidateTargets({ os, arch, installer }) {
  return [`${os}-${arch}-${installer}`, `${os}-${arch}`]
}

/**
 * Resolve one platform against a manifest, the way the plugin would.
 *
 * Returns `{ key, url, signature }` for the first candidate present, or `null`
 * when the manifest carries no entry for this platform — which on a real
 * device is `Error::TargetsNotFound`, the exact error that produced the
 * "Windows only" message this repository shipped.
 */
export function resolveTarget(manifest, target) {
  const platforms = manifest?.platforms
  if (!platforms || typeof platforms !== 'object') return null
  for (const key of candidateTargets(target)) {
    const entry = platforms[key]
    if (entry && typeof entry.url === 'string' && typeof entry.signature === 'string') {
      return { key, url: entry.url, signature: entry.signature }
    }
  }
  return null
}

/** A plain MAJOR.MINOR.PATCH version, the shape every release identity uses. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Is `candidate` strictly newer than `current`?
 *
 * The plugin compares with `semver`, so this does too — numerically per
 * component, NOT lexicographically. `"0.1.10" > "0.1.9"` is true numerically
 * and FALSE as a string comparison, and a release that sorts wrongly here is a
 * release half the installed base never sees.
 */
export function isNewerVersion(current, candidate) {
  const a = SEMVER.exec(String(current))
  const b = SEMVER.exec(String(candidate))
  if (!a || !b) return false
  for (let i = 1; i <= 3; i += 1) {
    const left = Number(a[i])
    const right = Number(b[i])
    if (right > left) return true
    if (right < left) return false
  }
  return false
}

/**
 * Every way a manifest fails to be an updatable release.
 *
 * An empty array means the release can update Windows, Apple Silicon and Intel
 * Macs from the same version.
 */
export function findManifestProblems(manifest, targets = REQUIRED_TARGETS) {
  const problems = []

  if (!manifest || typeof manifest !== 'object') {
    return ['the manifest is not a JSON object']
  }
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  if (!SEMVER.test(version)) {
    problems.push(`version "${manifest.version}" is not a plain MAJOR.MINOR.PATCH version`)
  }
  if (!manifest.platforms || typeof manifest.platforms !== 'object') {
    return [...problems, 'the manifest has no `platforms` object']
  }

  for (const target of targets) {
    const label = `${target.os}-${target.arch}`
    const resolved = resolveTarget(manifest, target)
    if (!resolved) {
      problems.push(
        `${label}: no updater artifact. Tried ${candidateTargets(target)
          .map((k) => `\`${k}\``)
          .join(' then ')}; the manifest only carries ${Object.keys(manifest.platforms)
          .sort()
          .map((k) => `\`${k}\``)
          .join(', ')}`,
      )
      continue
    }
    // A signature that is empty is not a signature. Without it the client
    // refuses the update at download time, so the artifact is as good as
    // absent — and it is invisible in a release listing.
    if (resolved.signature.trim() === '') {
      problems.push(`${label}: the updater artifact \`${resolved.key}\` has an empty signature`)
    }
    if (resolved.url.endsWith('.dmg')) {
      problems.push(
        `${label}: \`${resolved.key}\` points at a .dmg, which the updater cannot install. It must point at the signed .app.tar.gz`,
      )
    }
  }

  return problems
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node scripts/verify-release-manifest.mjs <path-to-latest.json>')
    process.exit(2)
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`error: cannot read ${file} as JSON: ${error.message}`)
    process.exit(1)
  }

  const problems = findManifestProblems(manifest)
  if (problems.length > 0) {
    console.error(
      `error: release ${manifest.version ?? '(no version)'} is not updatable everywhere:`,
    )
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  console.log(`release manifest ok: version ${manifest.version}`)
  for (const target of REQUIRED_TARGETS) {
    const { key, url } = resolveTarget(manifest, target)
    console.log(`  ${key} -> ${url}`)
  }
}

// Only run the CLI when this file is the process entry point, so the module can
// be imported and unit-tested without a manifest path.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
