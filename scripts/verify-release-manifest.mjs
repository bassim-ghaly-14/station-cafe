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
 *
 * The path argument is untrusted input: it is resolved and must land inside
 * this repository or a temp directory (the release workflow validates the
 * manifest it downloaded into `$RUNNER_TEMP`). Nothing outside those roots is
 * ever read, and no filesystem path, URL, signature or raw error text is
 * printed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** The repository root: one level above `scripts/`, derived from this file. */
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/**
 * Roots a release manifest is allowed to live in.
 *
 * The gate is deliberately not confined to the checkout: the release workflow
 * downloads the published `latest.json` into the runner's scratch directory
 * (`$RUNNER_TEMP/manifest/latest.json`) and validates those exact bytes, and
 * locally the file usually sits in a temp directory next to a downloaded
 * release. Everything else — `/etc/passwd`, `~/.ssh/id_ed25519`, another
 * checkout — is out of bounds. These roots are derived from the script's own
 * location and from the platform temp directory, never from a machine-specific
 * literal and never from the user's home directory.
 */
export function allowedManifestRoots() {
  const candidates = [REPO_ROOT, os.tmpdir(), process.env.RUNNER_TEMP]
  const roots = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const absolute = path.resolve(candidate)
    // Resolve symlinks so a root like macOS `/var` -> `/private/var` compares
    // equal to a realpath'd target. Best effort: an unreadable root keeps its
    // lexical form rather than aborting the CLI.
    const real = safeRealpath(absolute)
    for (const root of new Set([absolute, real])) {
      if (!roots.includes(root)) roots.push(root)
    }
  }
  return roots
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/** Is `target` inside `root`? A `path.relative`-based containment check, never a
 * string prefix: `/repo/releases2` is NOT inside `/repo/releases`. */
function isInside(root, target) {
  const relative = path.relative(root, target)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return !relative.startsWith(`..${path.sep}`) && relative !== '..'
}

/**
 * Resolve the CLI manifest path, or throw a controlled validation error.
 *
 * The argument is untrusted input, so it is never handed to `fs` as written:
 * it is resolved against the current working directory (GitHub Actions runs this
 * from the checkout root, which is why a relative path must keep working) and
 * the absolute result must land inside an allowed root. Traversal segments and
 * absolute paths are resolved first and rejected afterwards, so `../x`,
 * `a/../../x` and a Windows-style `..\..\x` all end up outside and fail.
 */
export function resolveManifestPath(input, roots = allowedManifestRoots()) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('no release manifest path was given')
  }
  const candidate = input.trim()
  // A path shaped like a Windows absolute path (`C:\...`, `\\server\share`) is
  // not a path this host can serve: `path.resolve` would read it as a relative
  // FILENAME and join it onto the cwd. Reject it instead of normalising, so a
  // foreign separator can never be used to reach a root.
  if (path.sep === '/' && (/^[a-zA-Z]:[\\/]/.test(candidate) || /^\\\\/.test(candidate))) {
    throw new Error('the release manifest path must be a path inside this environment')
  }
  const resolved = path.resolve(candidate)

  const real = safeRealpath(resolved)
  if (!roots.some((root) => isInside(root, resolved) || isInside(root, real))) {
    throw new Error('the release manifest path must stay inside the repository or a temp directory')
  }
  return real
}

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

/** A target key is a short, lowercase, dash-separated token. */
const PLATFORM_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** How many manifest keys a diagnostic is allowed to name. */
const MAX_LISTED_KEYS = 12

/**
 * The manifest's platform keys, safe to print.
 *
 * Keys are attacker-controlled strings, so only well-formed target keys are
 * listed, at most `MAX_LISTED_KEYS` of them, in a deterministic order. Anything
 * else is reported as a count, so the diagnostic still identifies which required
 * target is missing without dumping arbitrary content into a CI log.
 */
function describePlatformKeys(platforms) {
  const safe = Object.keys(platforms).filter((key) => PLATFORM_KEY.test(key))
  const shown = safe
    .slice(0, MAX_LISTED_KEYS)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `\`${key}\``)
  const hidden = safe.length - shown.length
  const listed = shown.length > 0 ? shown.join(', ') : 'no well-formed target keys'
  return hidden > 0 ? `${listed} (+${hidden} more)` : listed
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
    // The offending value is deliberately NOT echoed: `version` is
    // manifest-controlled and ends up in CI logs. The message stays just as
    // actionable because it names the field and the required shape.
    problems.push('`version` is not a plain MAJOR.MINOR.PATCH version')
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
          .join(' then ')}; the manifest only carries ${describePlatformKeys(manifest.platforms)}`,
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
  let file
  try {
    file = resolveManifestPath(process.argv[2])
  } catch {
    // Neither the argument nor the rejection reason is echoed: both can carry
    // filesystem layout a CI log has no business repeating. The message names
    // the accepted locations so the fix is obvious.
    console.error(
      'usage: node scripts/verify-release-manifest.mjs <path-to-latest.json>\n' +
        'the path must name a file inside this repository or the system temp directory',
    )
    process.exit(2)
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // A read failure embeds the absolute path and the OS error text; a parse
    // failure embeds the offending bytes. Neither is printed.
    console.error('error: unable to read the release manifest')
    process.exit(1)
  }

  const problems = findManifestProblems(manifest)
  if (problems.length > 0) {
    // `manifest.version` is manifest-controlled and reaches CI logs, so it is
    // printed only once it has passed the semantic-version check above — which
    // a manifest reaching this branch with no version problem has.
    const version = typeof manifest?.version === 'string' && SEMVER.test(manifest.version)
    console.error(
      `error: release ${version ? `v${manifest.version}` : '(unvalidated version)'} is not updatable everywhere:`,
    )
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  console.log(`release manifest ok: version ${manifest.version}`)
  for (const target of REQUIRED_TARGETS) {
    const { key } = resolveTarget(manifest, target)
    // Resolution is reported, the URL is not: it is manifest-controlled and may
    // carry tokens, signed query strings or private-host names.
    console.log(`  ${key} -> resolved`)
  }
}

// Only run the CLI when this file is the process entry point, so the module can
// be imported and unit-tested without a manifest path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
