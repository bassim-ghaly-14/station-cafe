/**
 * Runtime resolution check for the `errors.*` namespace.
 *
 * The `errors` catalogue stores FLAT keys that themselves contain dots
 * (`"employee.invalid_salary"`), not nested objects. A static walk of the JSON
 * therefore reports them as missing, which is a false positive — the real
 * question is whether i18next resolves them, so this asserts the rendered
 * Arabic rather than the JSON shape.
 *
 * This guards the Employees dialogs specifically: a missing validation key
 * prints a raw `errors.…` string to a user, which is exactly the kind of defect
 * a type checker and a linter both pass straight through.
 */
import { describe, expect, it } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { act } from 'react'

const KEYS = [
  'errors.employee.invalid_salary',
  'errors.employee.name_required',
  'errors.employee.invalid_type',
  'errors.user.password_invalid',
  'errors.attendance.already_checked_in',
  'errors.attendance.already_present',
  'errors.attendance.check_out_before_in',
  'errors.attendance.invalid_time',
  'errors.attendance.override_requires_time',
  'errors.attendance.override_requires_present',
  'errors.attendance.employee_inactive',
  'errors.auth.forbidden',
]

describe('errors namespace resolution', () => {
  it('resolves every flat dotted key to real Arabic, never to a raw key', async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
    for (const key of KEYS) {
      const value = i18n.t(key)
      expect(value, `${key} did not resolve`).not.toBe(key)
      // A raw key would still be a valid string, so check for the tell-tale dots
      // and namespaces that indicate the lookup fell through.
      expect(value).not.toMatch(/^(errors|employees|app)\./)
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })
})
