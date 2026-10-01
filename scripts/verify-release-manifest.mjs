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
 * The path argument is untrusted input. It is never handed to `fs` as written:
 * every segment must match an allowlist (`SAFE_SEGMENT`, so no `..`, separator,
 * drive letter or UNC share can survive), the candidate is rebuilt from an
 * EXPLICIT trusted root — this repository, or the system temp directory the
 * release workflow downloads into — and the result must still be inside that
 * root after symlinks are resolved. Nothing outside those roots is ever read.
 *
 * The manifest itself is untrusted too. `manifest.version` is never read into a
 * log line: it passes through `getValidatedManifestVersion`, which rebuilds it
 * from its numeric captures or refuses it, and only that value is printed. No
 * filesystem path, URL, signature, token or raw error text is ever printed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** The repository root: one level above `scripts/`, derived from this file. */
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/**
 * A plain MAJOR.MINOR.PATCH version, the shape every release identity uses.
 *
 * No leading zeros and no unbounded digit runs: the components are rebuilt into
 * the value this script is allowed to print, so they must be short, canonical
 * digits. `01.1.1` and `0000.0000.0000` are not versions the `semver` crate
 * would ever produce, so they are not versions this gate accepts either.
 */
const SEMVER = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/

/**
 * The one shape of path segment this script is willing to put on disk.
 *
 * A segment must start with an alphanumeric character and may then contain only
 * alphanumerics, `.`, `_` and `-`. That single rule rules out, by construction:
 *
 *   - `.` and `..`      -> a segment can never start with `.`
 *   - `..` traversal    -> ditto, however it is spelled or truncated (`....`)
 *   - `/` and `\`       -> a segment can never contain a separator
 *   - `C:` / `\\server` -> `:` and `\` are not in the allowed set
 *   - URLs, NUL bytes, newlines, terminal escapes -> not alphanumeric
 *
 * It is an ALLOWLIST: anything not positively recognised is rejected, so a
 * segment this rule has never seen cannot reach the filesystem.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Is this character one a filename here must never carry?
 *
 * A code-point check rather than a regex over control characters: a NUL byte
 * truncates the path in every libc call, and a newline, carriage return or
 * terminal escape is log injection dressed as a filename.
 */
function isForbiddenPathCharacter(character) {
  const code = character.codePointAt(0)
  return code <= 0x1f || code === 0x7f
}

/** A filesystem path long enough to be a command-line argument, not a payload. */
const MAX_PATH_LENGTH = 4096

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

/**
 * Canonicalise a path, resolving symlinks where the path exists.
 *
 * A path that does not exist yet (a legitimate `scripts/latest.json` that has
 * not been written) keeps its lexical form rather than aborting the CLI. Any
 * symlink that IS resolvable is followed, which is what turns a
 * `repo/link -> /etc` escape into a path that is visibly outside the root.
 */
function safeRealpath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * Is `target` inside `root`? A `path.relative`-based containment check, never a
 * string prefix: `/repo/releases2` is NOT inside `/repo/releases`, and neither
 * is `/repo/releases/../../etc`.
 */
export function isPathInsideRoot(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  if (root === '' || target === '') return false
  const relative = path.relative(root, target)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/** Canonical forms of the allowed roots: the lexical path AND its realpath. */
function canonicalRoots(roots) {
  const canonical = []
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim() === '') continue
    const absolute = path.resolve(root)
    for (const candidate of [absolute, safeRealpath(absolute)]) {
      if (!canonical.includes(candidate)) canonical.push(candidate)
    }
  }
  return canonical
}

/** A UNC share root (`\\server\share\`), which is never an allowed location. */
const UNC_SHARE = /^\\\\/

/**
 * Parse the untrusted CLI argument into `{ absolute, segments }`, or throw.
 *
 * This is the trust boundary for S8707: nothing downstream ever sees the
 * caller's string, only a list of segments that were individually validated.
 *
 * WHAT IS REJECTED, AND WHY
 * -------------------------
 *   `../outside.json`        `..` is never an allowed segment
 *   `a/../../outside.json`   the same, wherever it appears in the path
 *   `....\outside.json`      `..\x` on POSIX, and `...` never matches `SAFE_SEGMENT`
 *   `C:\outside\latest.json` a foreign separator on POSIX, a drive letter on POSIX
 *   `C:/outside/latest.json` same, via the `^[a-zA-Z]:` drive-letter shape
 *   `\server\share\latest.json`  UNC -> leading separator(s), never a plain name
 *   `//server/share/latest.json`  the same
 *   `link/latest.json` (a symlink to /etc)  rejected later, by CONTAINMENT
 *   `/repo/releases-evil/latest.json`      rejected later, by CONTAINMENT
 *
 * RELATIVE input is fully ALLOWLISTED (`SAFE_SEGMENT` per segment): the caller
 * is naming the manifest inside a trusted root, so every name it supplies must
 * be a plain file name. ABSOLUTE input is accepted — the release workflow
 * passes `$RUNNER_TEMP/manifest/latest.json` — but only after traversal,
 * control characters and foreign separators are refused, and it must then pass
 * the containment check in `resolveManifestPath`. A relative path never keeps a
 * `..`, so containment can never be escaped by the argument itself.
 */
function parseManifestPath(input) {
  const raw = input.trim()
  if (raw.length > MAX_PATH_LENGTH) {
    throw new Error('the release manifest path is too long')
  }
  // A NUL byte truncates the path in every libc call; a newline or an escape
  // sequence is log injection dressed as a filename.
  if ([...raw].some(isForbiddenPathCharacter)) {
    throw new Error('the release manifest path must not contain control characters')
  }
  // A backslash is a separator on Windows and nothing at all on POSIX, where it
  // could only be smuggling `..\` or a drive letter into a filename.
  if (path.sep !== '\\' && raw.includes('\\')) {
    throw new Error('the release manifest path must use this platform’s separator')
  }
  const unified = path.sep === '\\' ? raw.split('/').join('\\') : raw
  if (UNC_SHARE.test(unified)) {
    throw new Error('the release manifest path must be a local path, not a network share')
  }
  // A drive-letter path (`C:\...`, `D:/...`) is a real location on a Windows
  // runner — that is where `$RUNNER_TEMP` lives — but on POSIX it could only be
  // a filename that happens to contain a colon, so it is refused there.
  if (path.sep !== '\\' && /^[a-zA-Z]:/.test(unified)) {
    throw new Error('the release manifest path must be a path inside this environment')
  }
  const absolute = path.isAbsolute(unified)
  // The trusted part of an absolute path: `/` on POSIX, `C:\` on Windows. Taken
  // from the validated string, never used to widen the allowed set.
  const root = absolute ? path.parse(unified).root : ''
  // Everything after the root, split into the segments that must be allowlisted.
  const segments = (absolute ? unified.slice(root.length) : unified).split(path.sep)
  for (const segment of segments) {
    // Empty (`//`, a trailing slash), `.` or `..`: never a manifest location.
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('the release manifest path may not contain traversal segments')
    }
    if (!SAFE_SEGMENT.test(segment)) {
      throw new Error('the release manifest path may only name plain file names')
    }
  }
  if (segments.length === 0) {
    throw new Error('the release manifest path may only name plain file names')
  }
  // REBUILT, never the caller's string: `absoluteForm` is provably free of `..`
  // and of any character `SAFE_SEGMENT` refused. A relative path is instead
  // joined onto an EXPLICIT trusted root further down.
  return { absolute, absoluteForm: path.join(root, ...segments), segments }
}

/**
 * Resolve the untrusted CLI manifest path to a VALIDATED filesystem path, or
 * throw a controlled validation error.
 *
 *   UNTRUSTED INPUT (process.argv[2])
 *        -> parseManifestPath  (allowlist, per segment; no `..` can survive)
 *        -> isPathInsideRoot   (path-aware containment, symlinks resolved)
 *        -> TRUSTED PATH       (handed to fs)
 *
 * The caller-controlled string never chooses the base directory: a relative
 * path is joined onto an EXPLICIT trusted root — the checkout — and the joined
 * result must be contained in that root both lexically and after symlink
 * resolution. An absolute path is accepted only when it is already contained in
 * a trusted root.
 */
export function resolveManifestPath(input, roots = allowedManifestRoots()) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('no release manifest path was given')
  }
  const { absolute, absoluteForm, segments } = parseManifestPath(input)
  const trustedRoots = canonicalRoots(roots)
  if (trustedRoots.length === 0) {
    throw new Error('the release manifest path must stay inside the repository or a temp directory')
  }

  // A relative path is resolved against the FIRST trusted root only — the
  // checkout — which is the documented meaning of `verify-release-manifest.mjs
  // latest.json`. It is never retried against another root: that would turn a
  // rejected symlink escape into a silently accepted miss somewhere else.
  // An absolute path (`$RUNNER_TEMP/manifest/latest.json`) keeps its own
  // location and is only accepted when that location is inside a trusted root.
  const candidates = absolute ? [absoluteForm] : [path.join(trustedRoots[0], ...segments)]
  for (const candidate of candidates) {
    // TWO INDEPENDENT containment decisions, and both must hold:
    //   1. the path AS GIVEN must sit inside an allowed root — this is what
    //      rejects `/repo/releases-evil/latest.json` and every `..` escape;
    //   2. the SYMLINK-RESOLVED path must ALSO sit inside an allowed root —
    //      this is what rejects `repo/link -> /etc/passwd`.
    // They are separate checks because a root is registered in both its lexical
    // and its realpath'd form (macOS `/var` -> `/private/var`), and a candidate
    // in one form resolves into the other. Requiring both inside *some* allowed
    // root still means neither the written path nor where it points can leave
    // the allowed set.
    const resolved = safeRealpath(candidate)
    const insideAsWritten = trustedRoots.some((root) => isPathInsideRoot(root, candidate))
    const insideResolved = trustedRoots.some((root) => isPathInsideRoot(root, resolved))
    if (!insideAsWritten || !insideResolved) continue
    // The value returned here is the one, and only, path this module hands to
    // `fs`: it was rebuilt from a trusted root plus allowlisted segments and
    // re-checked after symlink resolution.
    return resolved
  }
  throw new Error('the release manifest path must stay inside the repository or a temp directory')
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
 * A target key is a short, lowercase, dash-separated token.
 *
 * Rebuild a manifest key from the allowed character set, or refuse it.
 *
 * This is an ALLOWLIST sanitizer, not a `test()` guard: the returned string is
 * assembled character by character from `[a-z0-9._-]`, starts with an
 * alphanumeric, is capped at 64 characters, and is only accepted when the
 * rebuilt string is byte-identical to the input. A key carrying a URL, a query
 * string, a token, a backslash, a space, a newline or a terminal escape is
 * dropped here and never reaches a log line.
 */
const TARGET_KEY_CHARACTER = /^[a-z0-9._-]$/
const MAX_TARGET_KEY_LENGTH = 64

function sanitizeTargetKey(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.slice(0, MAX_TARGET_KEY_LENGTH + 1)
  if (trimmed.length === 0 || trimmed.length > MAX_TARGET_KEY_LENGTH) return null
  const rebuilt = [...trimmed]
    .map((character) => (TARGET_KEY_CHARACTER.test(character) ? character : ''))
    .join('')
  if (rebuilt.length === 0) return null
  if (!/^[a-z0-9]/.test(rebuilt)) return null
  // Anything the allowlist had to remove makes this a non-token: refuse it
  // outright rather than printing a mangled approximation of the real key.
  return rebuilt === trimmed ? rebuilt : null
}

/** How many manifest keys a diagnostic is allowed to name. */
const MAX_LISTED_KEYS = 12

/**
 * The manifest's platform keys, safe to print.
 *
 * Keys are attacker-controlled strings, so only keys that survive
 * `sanitizeTargetKey` are listed, at most `MAX_LISTED_KEYS` of them, in a
 * deterministic order. Anything else is reported as a count, so the diagnostic
 * still identifies which required target is missing without dumping arbitrary
 * manifest content into a CI log.
 */
function describePlatformKeys(platforms) {
  const safe = Object.keys(platforms)
    .map((key) => sanitizeTargetKey(key))
    .filter((key) => key !== null)
  const shown = safe
    .slice(0, MAX_LISTED_KEYS)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `\`${key}\``)
  const hidden = safe.length - shown.length
  const listed = shown.length > 0 ? shown.join(', ') : 'no well-formed target keys'
  return hidden > 0 ? `${listed} (+${hidden} more)` : listed
}

/**
 * The manifest's version, validated once, or `null`.
 *
 * `manifest.version` is manifest-controlled, so it is never interpolated into a
 * log line directly. This function is the ONLY bridge between that value and
 * anything printed: it accepts the value only when it matches a plain
 * MAJOR.MINOR.PATCH shape, and it returns a string REBUILT from the three
 * numeric captures. A rebuilt value is digits and two dots and nothing else, so
 * no URL, token, newline, terminal escape or log-forging prefix can survive
 * into `console.log`/`console.error`.
 *
 * @returns {string | null} `MAJOR.MINOR.PATCH`, or `null` when the manifest's
 *   version is absent, of another type, or not a plain release version.
 */
export function getValidatedManifestVersion(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const raw = manifest.version
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 32) return null
  const match = SEMVER.exec(raw)
  if (!match) return null
  // Rebuild from the captured digits: the returned string is constructed here,
  // so it carries only what the pattern recognised.
  return `${match[1]}.${match[2]}.${match[3]}`
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
  // Validation and reporting are separate concerns: this function only decides
  // WHAT is wrong, and every dynamic fragment it returns has already been
  // through `sanitizeTargetKey` or is a literal defined in this file.
  if (getValidatedManifestVersion(manifest) === null) {
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
  // TRUST BOUNDARY 1 — the filesystem.
  // `process.argv[2]` is untrusted. `resolveManifestPath` allowlists every path
  // segment, rebuilds the path from an explicitly trusted root, and re-checks
  // containment after symlink resolution. The value assigned to `manifestPath`
  // below is therefore NOT the CLI argument: it is a validated path, and it is
  // the only path this function ever passes to `fs`.
  let manifestPath
  try {
    manifestPath = resolveManifestPath(process.argv[2])
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
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    // A read failure embeds the absolute path and the OS error text; a parse
    // failure embeds the offending bytes. Neither is printed.
    console.error('error: unable to read the release manifest')
    process.exit(1)
  }

  // TRUST BOUNDARY 2 — the logs.
  // `manifest` is entirely attacker-controlled once it is parsed, so nothing
  // below reads `manifest.version`, `manifest.platforms` or any other field
  // into a log line. The version is validated ONCE here, into a value rebuilt
  // from digits, and only that value is ever printed.
  const validatedVersion = getValidatedManifestVersion(manifest)

  const problems = findManifestProblems(manifest)
  if (problems.length > 0) {
    // `validatedVersion` is either a digits-and-dots string or `null`. The raw
    // manifest value is not reachable from this line at all.
    console.error(
      `error: release ${validatedVersion === null ? '(unvalidated version)' : `v${validatedVersion}`} is not updatable everywhere:`,
    )
    // Every problem string is built from literals in this file plus keys that
    // passed `sanitizeTargetKey`; no URL, signature, path or free text is here.
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  // A manifest with no problems has already passed the version check, so the
  // validated value is the one printed — `manifest.version` is never read here.
  if (validatedVersion === null) {
    console.error('error: the release manifest has no usable version')
    process.exit(1)
  }
  console.log(`release manifest ok: version ${validatedVersion}`)
  for (const target of REQUIRED_TARGETS) {
    const { key } = resolveTarget(manifest, target)
    // Resolution is reported, the URL is not: it is manifest-controlled and may
    // carry tokens, signed query strings or private-host names. `key` is one of
    // this file's own candidate names, not a manifest-controlled string.
    console.log(`  ${key} -> resolved`)
  }
}

// Only run the CLI when this file is the process entry point, so the module can
// be imported and unit-tested without a manifest path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
