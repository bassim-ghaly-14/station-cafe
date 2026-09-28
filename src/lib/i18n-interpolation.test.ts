/**
 * The i18n interpolation contract, checked from the RESOURCE side.
 *
 * A translation key that declares `{{name}}` is a promise: whoever calls `t`
 * must hand i18next a `name`. This file holds that promise to the locale files
 * themselves — it knows every placeholder each key declares, feeds i18next
 * exactly those, and asserts that nothing survives into the output.
 *
 * It also pins the failure MODE. i18next is configured without a
 * `missingInterpolationHandler` and without any stripping fallback, so a caller
 * that forgets a variable renders the raw `{{from}}` to the user. That is
 * deliberate: a literal placeholder is a visible defect, not a silent one. The
 * test below asserts it stays visible, so nobody can "fix" a leak by quietly
 * disabling interpolation.
 *
 * The CALLER side of the same contract — every `t("key", …)` in `src` supplying
 * the variables its key declares — cannot be checked from here; it is audited by
 * `scripts/i18n-callers.mjs` and, for the keys whose keys are computed at
 * runtime, by the component tests that render those paths.
 */
import { describe, expect, it } from 'vitest'
import i18n from './i18n'
import { formatWorkedDuration } from '@/features/employees/attendance'
import ar from '@/locales/ar/translations.json'

type Catalogue = Record<string, unknown>

/** Every leaf of a nested catalogue, keyed by its dotted path. */
function flatten(node: Catalogue, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object') Object.assign(out, flatten(value as Catalogue, path))
    else if (typeof value === 'string') out[path] = value
  }
  return out
}

const CATALOGUE = flatten(ar as Catalogue)

/** The distinct variables one string declares, in declaration order. */
function placeholdersOf(value: string): string[] {
  return [...new Set([...value.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1].trim()))].filter(
    Boolean,
  )
}

const DYNAMIC = Object.entries(CATALOGUE)
  .map(([key, value]) => ({ key, value, vars: placeholdersOf(value) }))
  .filter((entry) => entry.vars.length > 0)

/** A stand-in value per variable, so interpolation has something to substitute. */
function sampleValues(vars: string[]): Record<string, string> {
  return Object.fromEntries(vars.map((name) => [name, `«${name}»`]))
}

/** The pattern a leaked placeholder always matches, whatever it holds. */
const LEAKED_PLACEHOLDER = /\{\{|\}\}/

describe('locale interpolation contract', () => {
  it('declares placeholders the way i18next expects', () => {
    // The guard rail for the audit itself: if this ever reads 0, the audit below
    // would pass vacuously and prove nothing.
    expect(DYNAMIC.length).toBeGreaterThan(50)
  })

  it('leaves no placeholder behind when every declared variable is supplied', () => {
    const leaked = DYNAMIC.filter(({ key, vars }) => {
      const rendered = i18n.t(key, sampleValues(vars))
      return LEAKED_PLACEHOLDER.test(rendered)
    }).map(({ key }) => key)
    expect(leaked).toEqual([])
  })

  it('declares no placeholder shape i18next would not interpolate', () => {
    // `{{x}}` is the only interpolation form. A single brace, a spaced pair or
    // an unbalanced brace all reach the screen verbatim, so they are defects
    // wherever they appear in a user-facing string.
    const offenders = Object.entries(CATALOGUE)
      .filter(([, value]) => {
        const leftover = value.replace(/\{\{[^{}]*\}\}/g, '')
        const single = leftover.match(/(?<!\{)\{[A-Za-z_][A-Za-z0-9_]*\}(?!\})/)
        const opens = (leftover.match(/\{/g) ?? []).length
        const closes = (leftover.match(/\}/g) ?? []).length
        return single !== null || opens !== closes || /\{\{\s|\s\}\}/.test(value)
      })
      .map(([key, value]) => `${key}: ${value}`)
    expect(offenders).toEqual([])
  })

  it('resolves every dynamic key to a real sentence, never to the key itself', () => {
    const unresolved = DYNAMIC.filter(
      ({ key, vars }) => i18n.t(key, sampleValues(vars)) === key,
    ).map(({ key }) => key)
    expect(unresolved).toEqual([])
  })
})

describe('representative interpolations', () => {
  it('names the window of an empty period instead of printing {{from}} and {{to}}', () => {
    expect(i18n.t('expenses.states.noExpensesBody', { from: '01/09/2026', to: '28/09/2026' })).toBe(
      'لم يُسجَّل أي مصروف بين 01/09/2026 و28/09/2026. هذه إجابة حقيقية وليست خطأ، وستظهر التحليلات فور تسجيل أول مصروف.',
    )
  })

  it('interpolates two numbers into one sentence', () => {
    expect(i18n.t('settlement.progress', { settled: 3, pending: 1 })).toBe(
      '3 وردية متسوية · 1 بحاجة للتسوية',
    )
  })

  it('interpolates a count, and never a pluralised raw placeholder', () => {
    expect(i18n.t('catalog.hiddenCategoriesHint', { count: 3 })).toBe(
      'يوجد 3 تصنيف مخفي — يظهر عبر «إظهار الكل».',
    )
  })

  it('interpolates an hours/minutes pair in both orders the app renders', () => {
    expect(i18n.t('employees.duration.hoursMinutes', { hours: 8, minutes: 10 })).toBe('8س 10د')
    expect(i18n.t('employees.duration.minutes', { minutes: 45 })).toBe('45د')
  })

  it('surfaces a missing variable instead of hiding it', () => {
    // The counterpart to the audit: this is what a forgotten option looks like,
    // and it is why every caller has to pass the variables its key declares.
    const leaked = i18n.t('expenses.states.noExpensesBody', { from: '01/09/2026' })
    expect(leaked).toContain('{{to}}')
  })
})

describe('keys computed at runtime', () => {
  // A key built from a variable cannot be audited statically, so the paths that
  // build one are exercised here instead: the key must resolve, and the values
  // the caller hands it must be the ones the key declares.
  it('resolves every attendance confirmation the page names by suffix', () => {
    for (const suffix of ['checkIn', 'checkOut', 'absent', 'leave']) {
      expect(i18n.t(`employees.confirm.${suffix}`, { name: 'أحمد سيد' })).not.toMatch(
        /\{\{|\}\}|^employees\./,
      )
    }
  })

  it('formats a worked duration through the translator it is handed', () => {
    const translate = (key: string, options?: Record<string, unknown>) => i18n.t(key, options)
    expect(formatWorkedDuration(490, translate)).toBe('8س 10د')
    expect(formatWorkedDuration(45, translate)).toBe('45د')
  })

  it('resolves the POS table legend from the counts object it is given', () => {
    // The one call site whose options are a variable rather than an object
    // literal, so the static audit can only record that it exists.
    expect(i18n.t('pos.tablesLegend', { empty: 2, open: 1, occupied: 3 })).toBe(
      '2 فارغة · 1 مفتوحة · 3 بها طلب',
    )
  })
})
