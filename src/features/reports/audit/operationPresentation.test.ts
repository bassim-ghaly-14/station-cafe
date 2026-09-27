/**
 * Operation presentation — the manager-safe / admin-technical boundary.
 *
 * The contract under test is deliberately narrow and security-shaped:
 *   - a declared field is shown with an Arabic label and a readable value;
 *   - an UNDECLARED field is never shown, whatever the payload contains;
 *   - a stored code is translated or dropped, never printed;
 *   - missing, null, malformed and empty payloads all degrade quietly.
 */
import { describe, expect, it } from 'vitest'
import i18n from '@/lib/i18n'
import {
  businessDetails,
  businessHighlights,
  canViewTechnicalDetails,
  operationFields,
  operationSummary,
  technicalSnapshot,
  type AuditTranslate,
} from './operationPresentation'
import type { AuditEntry } from '@/services/opsApi'

const t: AuditTranslate = (key, options) =>
  options ? String(i18n.t(key, options as never)) : String(i18n.t(key))

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: 1,
    actor_id: 1,
    actor_name: 'سارة',
    actor_role: 'MANAGER',
    action: 'invoice.created',
    entity_type: 'invoice',
    entity_id: '1042',
    after_json: null,
    created_at: '2026-09-25 10:00:00Z',
    ...overrides,
  }
}

describe('business details', () => {
  it('turns a recorded invoice snapshot into manager-readable rows', () => {
    const rows = businessDetails(
      t,
      entry({
        after_json: JSON.stringify({
          invoice_no: '1042',
          method: 'CARD',
          total: 15000,
          discount: 0,
          service_charge: 250,
          order_type: 'TAKEAWAY',
          takeaway_no: 'T-9',
        }),
      }),
    )

    expect(rows).toEqual([
      { label: 'رقم الفاتورة', value: '1042' },
      { label: 'الإجمالي', value: '150.00 ج.م' },
      { label: 'طريقة الدفع', value: 'بطاقة' },
      { label: 'الخصم', value: '0.00 ج.م' },
      { label: 'رسوم الخدمة', value: '2.50 ج.م' },
      { label: 'نوع الطلب', value: 'طلب خارجي' },
      { label: 'رقم الطلب الخارجي', value: 'T-9' },
    ])
  })

  it('reads money as piastres and counts as plain numbers', () => {
    const closing = businessDetails(
      t,
      entry({
        action: 'shift.closed',
        entity_type: 'shift',
        after_json: JSON.stringify({
          expected_cash: 100000,
          actual_cash: 95000,
          difference: -5000,
          invoices_count: 12,
          status: 'CLOSED',
        }),
      }),
    )

    expect(closing).toEqual([
      { label: 'المبلغ المتوقع في الدرج', value: '1,000.00 ج.م' },
      { label: 'المبلغ الفعلي في الدرج', value: '950.00 ج.م' },
      { label: 'الفرق', value: '-50.00 ج.م' },
      { label: 'عدد الفواتير', value: '12' },
      { label: 'الحالة', value: 'مغلقة' },
    ])
  })

  it('translates the domain codes a record carries', () => {
    expect(
      businessDetails(
        t,
        entry({
          action: 'catalog.product_created',
          entity_type: 'product',
          after_json: JSON.stringify({
            name: 'كابتشينو',
            price_minor: 4500,
            department: 'CAFE',
            type: 'PRODUCT',
          }),
        }),
      ),
    ).toEqual([
      { label: 'الاسم', value: 'كابتشينو' },
      { label: 'السعر', value: '45.00 ج.م' },
      { label: 'القسم', value: 'كافيه' },

      { label: 'النوع', value: 'منتج' },
    ])

    expect(
      businessDetails(
        t,
        entry({
          action: 'employee.created',
          entity_type: 'employee',
          after_json: JSON.stringify({ employee_type: 'WASH_WORKER', base_salary: 300000 }),
        }),
      ).map((row) => row.value),
    ).toEqual(['عامل مغسلة', '3,000.00 ج.م'])
  })

  it('never shows a key the operation did not declare', () => {
    const rows = businessDetails(
      t,
      entry({
        action: 'auth.login',
        entity_type: 'user',
        // A payload the log does not document, plus internal keys.
        after_json: JSON.stringify({ token: 'secret', user_id: 4, password_hash: 'argon2' }),
      }),
    )

    expect(rows).toEqual([])
    expect(JSON.stringify(rows)).not.toContain('secret')
  })

  it('never shows an internal id, even for a declared action', () => {
    const rows = businessDetails(
      t,
      entry({
        action: 'table.opened',
        entity_type: 'table',
        after_json: JSON.stringify({ session_id: 88, shift_id: 3 }),
      }),
    )

    expect(rows).toEqual([])
  })

  it('drops a code with no Arabic name instead of printing it', () => {
    const rows = businessDetails(
      t,
      entry({
        action: 'expense.created',
        entity_type: 'expense',
        after_json: JSON.stringify({ category: 'RENT', amount: 500000, date: '2026-09-20' }),
      }),
    )

    // The amount survives; the unmapped category code does not.
    expect(rows.map((row) => row.label)).toEqual(['المبلغ', 'تاريخ المصروف'])
    expect(JSON.stringify(rows)).not.toContain('RENT')
  })

  it('degrades quietly for missing, null, malformed and empty payloads', () => {
    expect(businessDetails(t, entry({ after_json: null }))).toEqual([])
    expect(businessDetails(t, entry({ after_json: '' }))).toEqual([])
    expect(businessDetails(t, entry({ after_json: '{not json' }))).toEqual([])
    expect(businessDetails(t, entry({ after_json: '[1,2,3]' }))).toEqual([])
    expect(businessDetails(t, entry({ after_json: '"text"' }))).toEqual([])
  })

  it('skips null and wrongly typed values inside an otherwise valid payload', () => {
    const rows = businessDetails(
      t,
      entry({
        after_json: JSON.stringify({
          invoice_no: null,
          total: '150.00',
          method: '',
          order_type: 'TABLE',
        }),
      }),
    )

    expect(rows).toEqual([{ label: 'نوع الطلب', value: 'طلب على طاولة' }])
  })

  it('declares fields for the actions the log records, and nothing for the rest', () => {
    expect(operationFields('invoice.created')).toContain('invoice_no')
    expect(operationFields('auth.login')).toEqual([])
    // An action nobody declared (old record, newer build) is simply unknown.
    expect(operationFields('loyalty.points_redeemed')).toEqual([])
  })
})

describe('operation summary and highlights', () => {
  it('describes a known operation as a plain Arabic sentence', () => {
    expect(operationSummary(t, entry({}))).toBe('تم إنشاء فاتورة.')
    expect(operationSummary(t, entry({ action: 'shift.closed' }))).toBe('تم تقفيل وردية.')
  })

  it('describes an unknown operation safely, without its code', () => {
    const summary = operationSummary(
      t,
      entry({ action: 'loyalty.points_redeemed', after_json: '{"points":40}' }),
    )

    expect(summary).toBe('تم عملية غير معروفة.')
    expect(summary).not.toContain('loyalty')
  })

  it('summarises a row in at most a couple of scannable values', () => {
    const row = entry({
      after_json: JSON.stringify({ invoice_no: '1042', total: 15000, method: 'CARD' }),
    })

    expect(businessHighlights(t, row)).toBe('1042 · 150.00 ج.م')
    expect(businessHighlights(t, row, 1)).toBe('1042')
    expect(businessHighlights(t, entry({ after_json: null }))).toBe('')
  })
})

describe('technical section', () => {
  it('pretty-prints the stored payload for the admin viewer', () => {
    expect(technicalSnapshot('{"total":15000}')).toBe('{\n  "total": 15000\n}')
  })

  it('keeps a payload it cannot parse rather than losing the record', () => {
    expect(technicalSnapshot('{not json')).toBe('{not json')
    expect(technicalSnapshot(null)).toBe('')
  })

  it('is granted to ADMIN only and fails closed', () => {
    expect(canViewTechnicalDetails('ADMIN')).toBe(true)
    expect(canViewTechnicalDetails('MANAGER')).toBe(false)
    expect(canViewTechnicalDetails('STAFF')).toBe(false)
    expect(canViewTechnicalDetails(null)).toBe(false)
    expect(canViewTechnicalDetails(undefined)).toBe(false)
  })
})
