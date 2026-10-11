/**
 * Format a base-unit amount for humans: a quantity exactly divisible by 1000
 * is shown in the larger unit (kg/l) with an INTEGER quotient; anything else
 * stays in base units (g/ml). Always integer arithmetic — never a float —
 * and the active i18n locale's numerals, so Arabic renders Arabic-Indic digits.
 */
export function formatQuantity(amount: number, baseUnit: string, locale?: string): string {
  const lang = locale ?? (typeof navigator === 'undefined' ? 'ar-EG' : navigator.language)
  const abs = Math.abs(amount)
  const minor = baseUnit === 'GRAM' ? 'g' : 'ml'
  const major = baseUnit === 'GRAM' ? 'kg' : 'l'
  if (abs >= 1000 && abs % 1000 === 0) return `${(abs / 1000).toLocaleString(lang)} ${major}`
  return `${abs.toLocaleString(lang)} ${minor}`
}
