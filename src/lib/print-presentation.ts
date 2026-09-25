/**
 * Printing presentation layer — the single mapping between the printing
 * service's vocabulary and what a user sees.
 *
 * The backend stores technical identifiers (`TAKEAWAY_INVOICE`, `PRINTED`,
 * `printer.not_configured`, …) in `print_jobs` and raises them as stable error
 * codes. Those values are NEVER rendered: every document type, job status and
 * printer error is translated here, and anything unknown degrades to a safe
 * localized label instead of exposing an internal identifier.
 *
 * Adding a future document (another invoice shape, a wash ticket variant, a
 * day report, …) is one entry in `PRINT_DOCUMENTS` plus one translation key —
 * never another conditional inside a component.
 */
import type { TFunction } from 'i18next'
import {
  CalendarDays,
  Check,
  ClipboardList,
  Clock,
  Coffee,
  Droplets,
  Printer,
  Receipt,
  ScrollText,
  ShoppingBag,
  Ticket,
  X,
  type LucideIcon,
} from '@/components/ui/icon'
import { printJobBadgeVariant, type BadgeVariant } from '@/lib/status-badge'

/** Document identities the printing service records in `print_jobs.doc_type`. */
export const PRINT_DOCUMENT_TYPES = [
  'CAFE_INVOICE',
  'WASH_INVOICE',
  'HYBRID_INVOICE',
  'TAKEAWAY_INVOICE',
  'WASH_TICKET',
  'SHIFT_REPORT',
  'DAY_REPORT',
  'TEST',
] as const

export type PrintDocumentType = (typeof PRINT_DOCUMENT_TYPES)[number]

export interface PrintDocumentPresentation {
  /** Translation key of the human-readable document name. */
  labelKey: string
  /** Icon used beside the name so the document is recognizable at a glance. */
  icon: LucideIcon
}

const PRINT_DOCUMENTS: Record<PrintDocumentType, PrintDocumentPresentation> = {
  CAFE_INVOICE: { labelKey: 'print.document.cafeInvoice', icon: Coffee },
  WASH_INVOICE: { labelKey: 'print.document.washInvoice', icon: Droplets },
  HYBRID_INVOICE: { labelKey: 'print.document.hybridInvoice', icon: Receipt },
  TAKEAWAY_INVOICE: { labelKey: 'print.document.takeawayInvoice', icon: ShoppingBag },
  WASH_TICKET: { labelKey: 'print.document.washTicket', icon: Ticket },
  SHIFT_REPORT: { labelKey: 'print.document.shiftReport', icon: ClipboardList },
  DAY_REPORT: { labelKey: 'print.document.dayReport', icon: CalendarDays },
  TEST: { labelKey: 'print.document.testPage', icon: Printer },
}

/** Unmapped document — shown as a generic print document, never as its code. */
const UNKNOWN_DOCUMENT: PrintDocumentPresentation = {
  labelKey: 'print.document.unknown',
  icon: ScrollText,
}

export function printDocumentPresentation(
  docType: string | null | undefined,
): PrintDocumentPresentation {
  return PRINT_DOCUMENTS[docType as PrintDocumentType] ?? UNKNOWN_DOCUMENT
}

/** Localized document name (TAKEAWAY_INVOICE → «إيصال طلب خارجي»). */
export function printDocumentLabel(t: TFunction, docType: string | null | undefined): string {
  return t(printDocumentPresentation(docType).labelKey)
}

/** Job statuses the printing service records in `print_jobs.status`. */
export const PRINT_JOB_STATUSES = ['PENDING', 'PRINTED', 'FAILED'] as const

export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number]

export interface PrintJobStatusPresentation {
  /** Translation key of the user-facing status label. */
  labelKey: string
  /** Optional supporting line; null when the status needs no explanation. */
  hintKey: string | null
  /** Non-color status cue rendered inside the badge. */
  icon: LucideIcon
  /** Shared Station status color, reusing the global print-job mapping. */
  variant: BadgeVariant
}

const PRINT_JOB_STATUS: Record<PrintJobStatus, PrintJobStatusPresentation> = {
  PENDING: {
    labelKey: 'print.status.pending',
    hintKey: 'print.status.pendingHint',
    icon: Clock,
    variant: printJobBadgeVariant('PENDING'),
  },
  PRINTED: {
    labelKey: 'print.status.printed',
    hintKey: null,
    icon: Check,
    variant: printJobBadgeVariant('PRINTED'),
  },
  FAILED: {
    labelKey: 'print.status.failed',
    hintKey: null,
    icon: X,
    variant: printJobBadgeVariant('FAILED'),
  },
}

const UNKNOWN_JOB_STATUS: PrintJobStatusPresentation = {
  labelKey: 'print.status.unknown',
  hintKey: null,
  icon: Clock,
  variant: printJobBadgeVariant(null),
}

export function printJobStatusPresentation(
  status: string | null | undefined,
): PrintJobStatusPresentation {
  return PRINT_JOB_STATUS[status as PrintJobStatus] ?? UNKNOWN_JOB_STATUS
}

/**
 * Stable printer error codes emitted by the printing service, mapped to their
 * user-facing message. The keys are machine values (`printer.*`) and are never
 * rendered — only their translations are.
 */
const PRINTER_ERROR_MESSAGES = {
  'printer.not_configured': 'print.error.notConfigured',
  'printer.unavailable': 'print.error.unavailable',
  'printer.open_failed': 'print.error.openFailed',
  'printer.write_failed': 'print.error.writeFailed',
  'printer.flush_failed': 'print.error.flushFailed',
  'printer.spool_failed': 'print.error.spoolFailed',
  'printer.job_rejected': 'print.error.jobRejected',
} as const

export type PrinterErrorCode = keyof typeof PRINTER_ERROR_MESSAGES

/**
 * Extract the stable printer code from a raw error string.
 *
 * A recorded print job stores the backend `Display` output
 * (`"printer error: printer.not_configured"`), while an IPC failure carries the
 * bare machine key — both resolve to the same code here.
 */
export function printerErrorCode(raw: string | null | undefined): PrinterErrorCode | null {
  if (!raw) return null
  const codes = Object.keys(PRINTER_ERROR_MESSAGES) as PrinterErrorCode[]
  return codes.find((code) => raw.includes(code)) ?? null
}

/**
 * Localized message for a printer error recorded with a print job. Returns null
 * when there is no error; unknown errors fall back to the generic printing
 * message instead of exposing the raw backend text.
 */
export function printErrorMessage(t: TFunction, raw: string | null | undefined): string | null {
  if (!raw) return null
  const code = printerErrorCode(raw)
  return t(code ? PRINTER_ERROR_MESSAGES[code] : 'print.error.unknown')
}

/**
 * Localized reason shown for a recorded print job: the mapped printer message,
 * or the generic printing message when the job failed without a recorded error.
 * Returns null for jobs that did not fail.
 */
export function printJobErrorMessage(
  t: TFunction,
  job: { status: string | null | undefined; error: string | null | undefined },
): string | null {
  const message = printErrorMessage(t, job.error)
  if (message) return message
  return job.status === 'FAILED' ? t('print.error.unknown') : null
}

/**
 * Localized message for an error raised by a print command. Known printer codes
 * use the printing messages; other failures keep the shared error taxonomy
 * (session, authorization, …) and only then the generic printing fallback.
 */
export function printErrorText(t: TFunction, error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message === 'string' && printerErrorCode(message)) {
    return printErrorMessage(t, message) ?? t('print.error.unknown')
  }
  return t([
    `errors.${typeof message === 'string' ? message : 'internal_error'}`,
    'print.error.unknown',
  ])
}

/** Printer target configuration exposed by the printing service. */
export interface PrinterTarget {
  target: string | null | undefined
}

/**
 * True only when a real printer target exists — the printing service treats an
 * empty target and `none` as "printing is not configured on this device".
 */
export function printerIsConfigured(config: PrinterTarget | null | undefined): boolean {
  const target = config?.target?.trim() ?? ''
  return target.length > 0 && target !== 'none'
}
