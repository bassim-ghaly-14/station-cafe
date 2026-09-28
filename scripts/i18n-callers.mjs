/**
 * Static i18n audit — the two halves of an interpolation contract.
 *
 *   1. LOCALE SIDE — which keys declare `{{placeholders}}`, whether any locale
 *      declares a malformed or single-brace one, and whether two locales
 *      disagree about a key's variable set.
 *   2. CALLER SIDE — every `t("key", …)` call with a statically knowable key,
 *      compared against the contract the locale declares.
 *
 * Call sites whose key is computed at runtime (`t(\`errors.${code}\`)`) cannot be
 * checked statically and are reported as such; their paths are covered by the
 * runtime tests in `i18n-interpolation.test.tsx`.
 *
 * Usage: node scripts/i18n-callers.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const LOCALES = path.join(ROOT, 'src/locales')

function readDir(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readDir(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name))
      out.push(full)
  }
  return out
}

function flatten(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
    else out[key] = v
  }
  return out
}

// Collect placeholder contract per key, per locale, plus any malformed
// placeholders the locale file declares.
const contracts = new Map()
const malformed = []
for (const localeDir of fs.readdirSync(LOCALES, { withFileTypes: true })) {
  if (!localeDir.isDirectory()) continue
  for (const file of fs.readdirSync(path.join(LOCALES, localeDir.name))) {
    if (!file.endsWith('.json')) continue
    const locale = path.basename(file, '.json')
    const flat = flatten(
      JSON.parse(fs.readFileSync(path.join(LOCALES, localeDir.name, file), 'utf8')),
    )
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== 'string') continue
      const vars = new Set()
      for (const m of value.matchAll(/\{\{([^{}]*)\}\}/g)) {
        const name = m[1].trim()
        if (name) vars.add(name)
      }
      // Leftover single braces, doubled openers and unbalanced braces are all
      // shapes i18next will NOT interpolate — they reach the screen verbatim.
      const stripped = value.replace(/\{\{[^{}]*\}\}/g, '')
      const single = [...stripped.matchAll(/(?<!\{)\{[A-Za-z_][A-Za-z0-9_]*\}(?!\})/g)]
      const opens = (stripped.match(/\{/g) ?? []).length
      const closes = (stripped.match(/\}/g) ?? []).length
      const spaced = value.match(/\{\{\s|\s\}\}/g)
      if (single.length || opens !== closes || spaced) {
        malformed.push({
          locale,
          key,
          value,
          single: single.map((m) => m[0]),
          opens,
          closes,
          spaced,
        })
      }
      if (!contracts.has(key)) contracts.set(key, {})
      contracts.get(key)[locale] = [...vars].sort((a, b) => a.localeCompare(b))
    }
  }
}

// Two locales must agree on a key's variable set: the interpolation contract is
// the key's, not the language's.
const mismatchedLocales = []
for (const [key, byLocale] of contracts) {
  const locales = Object.keys(byLocale)
  if (locales.length < 2) continue
  const reference = JSON.stringify(byLocale[locales[0]])
  for (const locale of locales.slice(1)) {
    if (JSON.stringify(byLocale[locale]) !== reference) {
      mismatchedLocales.push({
        key,
        expected: byLocale[locales[0]],
        actual: byLocale[locale],
        locale,
      })
    }
  }
}

// Extract the top-level property names of the interpolation argument.
// Returns:
//   { kind: 'object', keys: string[], opaque: boolean }
//   { kind: 'unknown' }
// `keys` are the literal top-level property names; `opaque` is true when the
// object also spreads or computes its keys, so the static audit skips it.
function optionKeys(argsSrc, keyText) {
  const afterKey = argsSrc
    .slice(keyText.length)
    .replace(/^\s*,\s*/, '')
    .trimStart()
  if (afterKey === '') return { kind: 'object', keys: [], opaque: false }
  if (afterKey[0] !== '{') return { kind: 'unknown' }
  let depth = 0
  let end = -1
  for (let i = 0; i < afterKey.length; i++) {
    const c = afterKey[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return { kind: 'unknown' }
  const body = afterKey.slice(1, end)

  // Split the body on top-level commas only, ignoring strings/templates and
  // any nested `{...}`, `[...]` or `(...)`.
  const parts = []
  let current = ''
  let nest = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      current += c
      i++
      while (i < body.length) {
        current += body[i]
        if (body[i] === '\\') {
          current += body[i + 1] ?? ''
          i += 2
          continue
        }
        if (body[i] === quote) break
        i++
      }
      continue
    }
    if (c === '{' || c === '[' || c === '(') {
      nest++
      current += c
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      nest--
      current += c
      continue
    }
    if (c === ',' && nest === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (current.trim()) parts.push(current)

  const keys = new Set()
  let opaque = false
  for (const part of parts) {
    const text = part.trim()
    if (!text) continue
    if (text.startsWith('...')) {
      opaque = true
      continue
    }
    const m = text.match(/^([A-Za-z_$][\w$]*|"[^"]*"|'[^']*'|`[^`]*`)\s*:/)
    if (!m) {
      // Shorthand (`{ count }`) or a computed key — treat shorthand as known.
      const shorthand = text.match(/^([A-Za-z_$][\w$]*)$/)
      if (shorthand) keys.add(shorthand[1])
      else opaque = true
      continue
    }
    const name = m[1].replace(/^["'`](.*)["'`]$/, '$1')
    if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name)
    else opaque = true
  }
  return { kind: 'object', keys: [...keys], opaque }
}

// Balanced-paren arguments of a call starting at `(`.
function callArgs(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return null
}

// The first argument text of a call, i.e. everything before its top-level comma.
// A small scanner (not a regex) so string literals never confuse the nesting.
function firstArg(argsSrc) {
  let nest = 0
  let i = 0
  while (i < argsSrc.length) {
    const c = argsSrc[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < argsSrc.length) {
        if (argsSrc[i] === '\\') i++
        else if (argsSrc[i] === quote) break
        i++
      }
      i++
      continue
    }
    if (c === '{' || c === '[' || c === '(') nest++
    else if (c === '}' || c === ']' || c === ')') nest--
    else if (c === ',' && nest === 0) return argsSrc.slice(0, i)
    i++
  }
  return argsSrc
}

// Every key a first argument could resolve to. A plain literal yields one key;
// `cond ? 'a' : 'b'` yields both branches. A template literal or a variable
// yields nothing — those keys are resolved at runtime and covered by tests.
function keysOf(firstArgSrc) {
  const text = firstArgSrc.trim()
  if (/^(['"])(?:(?!\1).)*\1$/s.test(text)) return [text.slice(1, -1)]
  const literals = [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
  return literals.length > 0 ? literals : null
}

const CALL = /(?<![\w.$])(?:i18n\.)?t\s*\(/g
const findings = []
const opaqueCalls = []
const dynamicCalls = []
const auditedKeys = new Set()
const seen = []
let scannedFiles = 0
let callCount = 0

for (const file of readDir(path.join(ROOT, 'src'))) {
  scannedFiles++
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file)
  for (const match of src.matchAll(CALL)) {
    callCount++
    const openIdx = match.index + match[0].length - 1
    const args = callArgs(src, openIdx)
    if (args === null) continue
    const keyText = firstArg(args)
    const keys = keysOf(keyText)
    if (keys === null) {
      dynamicCalls.push({ file: rel, snippet: args.trim().slice(0, 80) })
      continue
    }
    const opts = optionKeys(args, keyText)
    const line = src.slice(0, match.index).split('\n').length
    for (const key of keys) {
      const contract = contracts.get(key)
      if (!contract) continue
      if (Object.values(contract).some((v) => v.length > 0)) auditedKeys.add(key)
      if (opts.kind === 'unknown' || opts.opaque) {
        opaqueCalls.push({ file: rel, line, key, args: args.trim().slice(0, 100) })
        continue
      }
      const supplied = opts.keys
      for (const [locale, vars] of Object.entries(contract)) {
        if (vars.length === 0) continue
        const missing = vars.filter((v) => !supplied.includes(v))
        const extra = supplied.filter((v) => !vars.includes(v))
        if (missing.length || extra.length) {
          findings.push({ file: rel, key, locale, missing, extra, line })
        }
        seen.push({ key, locale })
      }
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify({ malformed, mismatchedLocales, findings, opaqueCalls, dynamicCalls }, null, 2),
  )
} else {
  console.log(`malformed placeholders: ${malformed.length}`)
  for (const m of malformed) console.log(`  ${m.locale} ${m.key} ${JSON.stringify(m.value)}`)
  console.log(`cross-locale placeholder mismatches: ${mismatchedLocales.length}`)
  for (const m of mismatchedLocales)
    console.log(`  ${m.key} [${m.locale}] expected=[${m.expected}] actual=[${m.actual}]`)
  console.log(`\ndynamic keys audited: ${new Set(seen.map((s) => s.key)).size}`)
  console.log(`problem call sites: ${findings.length}`)
  for (const f of findings)
    console.log(
      `${f.file}:${f.line} ${f.key} [${f.locale}] missing=[${f.missing}] extra=[${f.extra}]`,
    )
  console.log(`\nopaque (spread/variable) option call sites: ${opaqueCalls.length}`)
  for (const c of opaqueCalls) console.log(`  ${c.file}:${c.line} ${c.key} -> ${c.args}`)
  console.log(`\nnon-literal t() key call sites: ${dynamicCalls.length}`)
  console.log('\ndynamic keys with NO literal t() call site (runtime-covered):')
  for (const key of [...contracts.keys()].sort((a, b) => a.localeCompare(b))) {
    const locale = Object.keys(contracts.get(key))[0]
    if (contracts.get(key)[locale].length === 0) continue
    if (auditedKeys.has(key)) continue
    console.log(`  ${key} => [${contracts.get(key)[locale].join(',')}]`)
  }
}

if (malformed.length || mismatchedLocales.length || findings.length) process.exitCode = 1

console.log(`\nsource files scanned: ${scannedFiles} | t() call sites scanned: ${callCount}`)
