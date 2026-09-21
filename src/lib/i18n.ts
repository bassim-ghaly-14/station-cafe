// i18n bootstrap — Arabic (Egypt) is the production language, RTL-first.
// English is pre-wired as a future fallback locale; only Arabic ships for now.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import ar from '@/locales/ar/common.json'

export const DEFAULT_LOCALE = 'ar-EG'
export const RTL_LOCALES = ['ar-EG'] as const

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.some((l) => locale.startsWith(l.split('-')[0]))
}

void i18n.use(initReactI18next).init({
  resources: {
    'ar-EG': { translation: ar },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: 'ar-EG',
  defaultNS: 'translation',
  interpolation: {
    // React already escapes by default
    escapeValue: false,
  },
})

// Keep <html dir/lang> in sync so RTL applies from the very first paint.
function applyDirection(locale: string) {
  document.documentElement.dir = isRtl(locale) ? 'rtl' : 'ltr'
  document.documentElement.lang = locale
}
applyDirection(i18n.language)
i18n.on('languageChanged', applyDirection)

export default i18n
