/**
 * Station Cafe — LOCAL WEB: Arabic strings.
 *
 * There is no second glossary here. The app fetches the SAME
 * `src/locales/ar/translations.json` the desktop application uses, which the
 * Rust server embeds and serves from `/assets/ar.json`. So a wording change on
 * the desktop reaches the phone too, and the two can never drift apart.
 *
 * The file is served from Station itself, so this works with the café's
 * internet completely unavailable.
 */

/**
 * Where the shared Arabic locale lives. Same origin, absolute path, no CDN —
 * so it can never be mistaken for an API route and never needs a base URL.
 */
export const STRINGS_URL = '/assets/ar.json'

/** Keys this surface needs. Listed so a missing key fails loudly in a test. */
export const REQUIRED_KEYS = [
  'app.name',
  'app.tagline',
  'auth.name',
  'auth.password',
  'auth.signIn',
  'auth.signingIn',
  'auth.logout',
  'auth.currentSession',
  'roles.ADMIN',
  'roles.MANAGER',
  'roles.STAFF',
  'errors.internal_error',
  'errors.auth.bad_credentials',
  'errors.auth.session_expired',
  'errors.auth.forbidden',
]

/** Falls back to the last segment so a missing key still reads as a word. */
function lastSegment(key) {
  return key.split('.').pop() ?? key
}

/**
 * A loaded locale, flattened to dotted keys.
 */
export class Strings {
  /** @param {Record<string, unknown>} tree */
  constructor(tree) {
    /** @type {Record<string, string>} */
    this.flat = {}
    this.flatten(tree, '')
  }

  /**
   * @param {Record<string, unknown>} node
   * @param {string} prefix
   */
  flatten(node, prefix) {
    for (const [key, value] of Object.entries(node ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.flatten(/** @type {Record<string, unknown>} */ (value), path)
      } else if (typeof value === 'string') {
        this.flat[path] = value
      }
    }
  }

  /**
   * Translate a dotted key.
   *
   * A missing key returns a neutral Arabic placeholder rather than `undefined`,
   * so a translation gap degrades to readable text instead of a blank screen.
   * Production never hits this: the required keys are asserted in a test.
   *
   * @param {string} key
   * @param {Record<string, string | number>} [values]
   */
  t(key, values) {
    const template = this.flat[key] ?? `?? ${lastSegment(key)}`
    if (!values) return template
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
      name in values ? String(values[name]) : match,
    )
  }
}

/**
 * Load the shared Arabic locale.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Strings>}
 */
export async function loadStrings(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) throw new Error('no fetch available for the locale')
  const response = await fetchImpl(STRINGS_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`locale unavailable: ${response.status}`)
  return new Strings(await response.json())
}

/**
 * The handful of strings that are about the LOCAL WEB surface itself and so do
 * not belong in the shared desktop locale: they describe the phone experience
 * and would be meaningless in the desktop app.
 *
 * Keeping them here, rather than adding them to translations.json, means the
 * desktop locale is not polluted with keys only the phone ever renders.
 */
export const LOCAL_STRINGS = {
  'local.title': 'Station Local',
  'local.subtitle': 'الواجهة المحلية على شبكة الكافيه',
  'local.connecting': 'جارٍ الاتصال بخادم Station…',
  'local.connectionLost': 'تعذّر الاتصال بالخادم. تأكد أن الجهاز مفعّل وأن الهاتف على نفس الشبكة.',
  'local.summaryTitle': 'ملخص اليوم',
  'local.role': 'الدور',
  'local.openDay': 'حالة يوم العمل',
  'local.openDayYes': 'مفتوح',
  'local.openDayNo': 'غير مفتوح',
  'local.forbidden': 'هذا الملخص متاح للمدير فقط.',
  'local.summaryUnavailable': 'تعذّر تحميل ملخص اليوم.',
  'local.sessionExpired': 'انتهت صلاحية الجلسة، سجّل الدخول من جديد.',
  'local.footer': 'يعمل بدون إنترنت — كل البيانات على جهاز الكافيه',
}
