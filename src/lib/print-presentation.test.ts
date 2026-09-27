/**
 * Printing presentation contract.
 *
 * The printing service stores technical identifiers (`TAKEAWAY_INVOICE`,
 * `PRINTED`, `printer.not_configured`, …). These tests pin the two guarantees
 * the UI depends on: every recorded value maps to natural Arabic, and nothing
 * unknown ever reaches the screen as a raw identifier.
 */
import { describe, expect, it } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import {
  PRINT_DOCUMENT_TYPES,
  PRINT_JOB_STATUSES,
  printDocumentFamily,
  printDocumentLabel,
  printDocumentPresentation,
  printErrorMessage,
  printErrorText,
  printJobErrorMessage,
  printJobStatusPresentation,
  printerErrorCode,
  printerIsConfigured,
} from './print-presentation'

const t = i18n.getFixedT(DEFAULT_LOCALE)

describe('print document presentation', () => {
  it('names every recorded document type in Arabic', () => {
    expect(PRINT_DOCUMENT_TYPES.map((docType) => printDocumentLabel(t, docType))).toEqual([
      'فاتورة كافيه',
      'فاتورة مغسلة',
      'فاتورة كافيه ومغسلة',
      'إيصال طلب خارجي',
      'تذكرة مغسلة سيارة',
      'تقرير وردية',
      'تقرير يوم العمل',
      'صفحة اختبار الطباعة',
    ])
  })

  it('falls back to a generic document name for unmapped or missing types', () => {
    expect(printDocumentLabel(t, 'SOME_FUTURE_DOC')).toBe('مستند طباعة')
    expect(printDocumentLabel(t, null)).toBe('مستند طباعة')
    expect(printDocumentLabel(t, undefined)).toBe('مستند طباعة')
    expect(printDocumentPresentation('SOME_FUTURE_DOC').labelKey).toBe('print.document.unknown')
  })

  it('never echoes the raw document identifier', () => {
    for (const docType of [...PRINT_DOCUMENT_TYPES, 'SOME_FUTURE_DOC']) {
      expect(printDocumentLabel(t, docType)).not.toContain(docType)
    }
  })

  it('groups every document into the noun family its own copy needs', () => {
    // Preview copy must be able to say «فاتورة» / «تذكرة» / «تقرير» without
    // repeating itself per backend identity.
    const families = Object.fromEntries(
      PRINT_DOCUMENT_TYPES.map((docType) => [docType, printDocumentFamily(docType)]),
    )
    expect(families).toEqual({
      CAFE_INVOICE: 'invoice',
      WASH_INVOICE: 'invoice',
      HYBRID_INVOICE: 'invoice',
      TAKEAWAY_INVOICE: 'invoice',
      WASH_TICKET: 'ticket',
      SHIFT_REPORT: 'report',
      DAY_REPORT: 'report',
      TEST: 'document',
    })
  })

  it('falls back to the neutral document family for anything unknown', () => {
    expect(printDocumentFamily('SOME_FUTURE_DOC')).toBe('document')
    expect(printDocumentFamily(null)).toBe('document')
    expect(printDocumentFamily(undefined)).toBe('document')
    // The fallback must not borrow another document's noun.
    expect(printDocumentFamily('SOME_FUTURE_DOC')).not.toBe('invoice')
  })

  it('has a translated empty-state message for every document family', () => {
    // Guards against a new family shipping with an untranslated preview state.
    const families = ['invoice', 'ticket', 'report', 'document'] as const
    for (const family of families) {
      expect(t(`documentPreview.empty.${family}.title`)).not.toBe(
        `documentPreview.empty.${family}.title`,
      )
      expect(t(`documentPreview.empty.${family}.body`).length).toBeGreaterThan(0)
    }
  })
})

describe('print job status presentation', () => {
  it('maps each recorded status to a label, an icon and the shared badge color', () => {
    const pending = printJobStatusPresentation('PENDING')
    expect(t(pending.labelKey)).toBe('بانتظار الطباعة')
    expect(pending.variant).toBe('warning')
    expect(pending.hintKey).not.toBeNull()
    expect(t(pending.hintKey!)).toBe('لم تصدر نتيجة لهذه العملية بعد')

    const printed = printJobStatusPresentation('PRINTED')
    expect(t(printed.labelKey)).toBe('تمت الطباعة')
    expect(printed.variant).toBe('success')
    expect(printed.hintKey).toBeNull()

    const failed = printJobStatusPresentation('FAILED')
    expect(t(failed.labelKey)).toBe('فشلت الطباعة')
    expect(failed.variant).toBe('danger')
  })

  it('keeps only the statuses the printing service records', () => {
    expect(PRINT_JOB_STATUSES).toEqual(['PENDING', 'PRINTED', 'FAILED'])
  })

  it('falls back to a neutral unknown status instead of the raw value', () => {
    const unknown = printJobStatusPresentation('PRINT_FAILED')
    expect(t(unknown.labelKey)).toBe('حالة غير معروفة')
    expect(unknown.variant).toBe('neutral')
    expect(printJobStatusPresentation(null)).toBe(unknown)
  })

  it('never echoes the raw status identifier', () => {
    for (const status of [...PRINT_JOB_STATUSES, 'PRINT_FAILED']) {
      expect(t(printJobStatusPresentation(status).labelKey)).not.toContain(status)
    }
  })
})

describe('printer errors', () => {
  it('reads the stable code out of both stored and raised error shapes', () => {
    // print_jobs.error stores the backend Display output for a failed job.
    expect(printerErrorCode('printer error: printer.not_configured')).toBe('printer.not_configured')
    // IPC failures carry the bare machine key.
    expect(printerErrorCode('printer.not_configured')).toBe('printer.not_configured')
    expect(printerErrorCode('printer.open_failed: No such file or directory')).toBe(
      'printer.open_failed',
    )
    expect(printerErrorCode('printer.job_rejected: lp: No such printer')).toBe(
      'printer.job_rejected',
    )
    expect(printerErrorCode(null)).toBeNull()
    expect(printerErrorCode('')).toBeNull()
  })

  it('translates a missing printer configuration to a user-facing message', () => {
    expect(printErrorMessage(t, 'printer error: printer.not_configured')).toBe(
      'لم يتم إعداد الطابعة بعد',
    )
    expect(printErrorMessage(t, 'printer.unavailable')).toBe('الطابعة غير متاحة حاليًا')
    expect(printErrorMessage(t, null)).toBeNull()
  })

  it('falls back to a safe localized message for unknown failures', () => {
    const message = printErrorMessage(t, 'lp: something exploded')
    expect(message).toBe('حدث خطأ أثناء الطباعة.')
    expect(message).not.toContain('lp')
  })

  it('guarantees a reason for a failed job even without a recorded error', () => {
    expect(printJobErrorMessage(t, { status: 'FAILED', error: null })).toBe(
      'حدث خطأ أثناء الطباعة.',
    )
    expect(printJobErrorMessage(t, { status: 'PRINTED', error: null })).toBeNull()
    expect(printJobErrorMessage(t, { status: 'FAILED', error: 'printer.spool_failed' })).toBe(
      'تعذر إرسال مهمة الطباعة إلى قائمة الطباعة',
    )
  })

  it('resolves command errors through the printing messages, then the shared taxonomy', () => {
    expect(printErrorText(t, { message: 'printer.not_configured' })).toBe(
      'لم يتم إعداد الطابعة بعد',
    )
    expect(printErrorText(t, { message: 'auth.session_expired' })).toBe(
      'انتهت صلاحية الجلسة، سجّل الدخول من جديد',
    )
    expect(printErrorText(t, { message: 'not.a.real.code' })).toBe('حدث خطأ أثناء الطباعة.')
    expect(printErrorText(t, new Error('boom'))).toBe('حدث خطأ أثناء الطباعة.')
  })
})

describe('printer configuration', () => {
  it('accepts a configured target and rejects the disabled one', () => {
    expect(printerIsConfigured({ target: 'share:XP80' })).toBe(true)
    expect(printerIsConfigured({ target: 'file:/tmp/out.prn' })).toBe(true)
    expect(printerIsConfigured({ target: 'none' })).toBe(false)
    expect(printerIsConfigured({ target: '   ' })).toBe(false)
    expect(printerIsConfigured({ target: '' })).toBe(false)
    expect(printerIsConfigured({ target: 'none ' })).toBe(false)
    expect(printerIsConfigured(null)).toBe(false)
    expect(printerIsConfigured(undefined)).toBe(false)
  })
})
