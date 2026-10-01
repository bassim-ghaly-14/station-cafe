/**
 * Version consistency gate.
 *
 * The Station release version is declared in THREE places, and the Windows
 * installer filename, the GitHub release tag and the updater manifest version
 * are all derived from it:
 *
 *   - package.json            ("version")
 *   - src-tauri/Cargo.toml    (package version)
 *   - src-tauri/tauri.conf.json ("version")
 *
 * Nothing forces them to agree, so a version bump that misses one file
 * silently ships an installer whose embedded version, release tag and
 * updater manifest version disagree. The Tauri updater compares the
 * manifest version against the running app's version, so a drift here is
 * not cosmetic: it can make a real update invisible to every client.
 *
 * This script fails loudly instead. It never writes a file: a build must not
 * be able to "fix" a version silently.
 *
 * Usage: node scripts/check-version.mjs [--tag <git-tag>]
 *   --tag  additionally requires the git tag to equal the version
 *          (a tag of v<version> is what tauri-action publishes under)
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Read a JSON file as UTF-8, failing with a readable message. */
const readJson = (relative) => {
  const file = path.join(ROOT, relative)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`cannot read ${relative}: ${error.message}`)
  }
}

const SPACE = /\s/
const isSpace = (c) => SPACE.test(c)
// The line terminators a multiline `^` anchors after — the same set JS uses.
const LINE_TERMINATORS = new Set(['\n', '\r', '\u2028', '\u2029'])

/** Index of the first non-whitespace character at or after `from`. */
const skipSpaces = (text, from) => {
  let i = from
  while (i < text.length && isSpace(text[i])) i++
  return i
}

/**
 * The value of the first `<key> = "…"` declaration in `text`, or null when it
 * declares none.
 *
 * Character-scanned rather than regex-matched: every token is anchored by a
 * literal or by a maximal whitespace run, so there is nothing to backtrack and
 * the scan is linear in `text.length`. Whitespace runs are consumed as maximal
 * runs, exactly as a greedy `\s*` does — a shorter run could only put a
 * whitespace character where a literal is required, so it can never match where
 * the maximal one does not.
 */
function declaredQuotedValue(text, key) {
  // A declaration can only begin at a line start, so only those are candidates.
  let candidate = 0
  while (candidate < text.length) {
    if (candidate > 0 && !LINE_TERMINATORS.has(text[candidate - 1])) {
      candidate++
      continue
    }
    const keyAt = skipSpaces(text, candidate)
    if (!text.startsWith(key, keyAt)) {
      // Every line start inside that whitespace run resumes at the same index
      // and reaches the same verdict, so jumping past them keeps this linear.
      candidate = keyAt > candidate ? keyAt : candidate + 1
      continue
    }
    let i = skipSpaces(text, keyAt + key.length)
    if (text[i] === '=') i = skipSpaces(text, i + 1)
    if (text[i] === '"') {
      const start = i + 1
      const end = text.indexOf('"', start) // `[^"]+` cannot cross a quote
      if (end > start) return text.slice(start, end)
    }
    candidate++
  }
  return null
}

/** Extract `version = "x"` from the [package] table of Cargo.toml. */
const cargoVersion = () => {
  const file = path.join(ROOT, 'src-tauri/Cargo.toml')
  let toml
  try {
    toml = fs.readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read src-tauri/Cargo.toml: ${error.message}`)
  }
  const version = declaredQuotedValue(toml, 'version')
  if (version === null) fail('no version = "..." found in src-tauri/Cargo.toml [package]')
  return version
}

const errors = []
const fail = (message) => {
  errors.push(message)
  return null
}

// `--tag` is optional. An EMPTY value (the non-tag case, where CI passes an
// empty string rather than omitting the flag) means "no tag to check" and is
// not treated as a mismatch.
const args = process.argv.slice(2)
const tagIndex = args.indexOf('--tag')
const tagArg = tagIndex === -1 ? null : (args[tagIndex + 1] ?? '')
const expectedTag = tagArg === '' ? null : tagArg

const sources = {
  'package.json': readJson('package.json')?.version,
  'src-tauri/Cargo.toml': cargoVersion(),
  'src-tauri/tauri.conf.json': readJson('src-tauri/tauri.conf.json')?.version,
}

const distinct = [...new Set(Object.values(sources))]
if (distinct.length !== 1) {
  errors.push(
    `version mismatch across the release version sources:\n` +
      Object.entries(sources)
        .map(([file, value]) => `    ${file.padEnd(28)} ${String(value)}`)
        .join('\n') +
      `\n  All four release identities (installer, release tag, updater manifest,` +
      `\n  running-app version) derive from this number. They must be identical.`,
  )
} else if (!/^\d+\.\d+\.\d+$/.test(distinct[0])) {
  errors.push(`version "${distinct[0]}" is not a plain MAJOR.MINOR.PATCH release version`)
}

if (expectedTag !== null) {
  const wanted = `v${distinct[0]}`
  if (expectedTag !== wanted) {
    errors.push(`git tag "${expectedTag}" does not match version: expected "${wanted}"`)
  }
}

if (errors.length) {
  for (const error of errors) console.error(`error: ${error}`)
  process.exit(1)
}

const suffix = expectedTag === null ? '' : ` (tag ${expectedTag} ✓)`
console.log(`version consistent: ${distinct[0]}${suffix}`)
