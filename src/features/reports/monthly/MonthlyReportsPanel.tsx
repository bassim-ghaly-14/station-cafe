/**
 * The Reports → "التقارير الشهرية" tab: pick a month, read the one-page summary,
 * print it.
 *
 * It is a SELECTOR and a preview, deliberately. The month list is not invented
 * here: it is the set of months the existing monthly sales report already
 * returns (`useMonthlyRevenue`), which is exactly the set of months the cafe has
 * business days for, so there is no second notion of "a month that exists".
 *
 * The preview IS the document — {@link MonthlyReportDocument} is mounted once and
 * used for both the screen and the printed page, so what the manager reads here
 * is what comes out of the printer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Button, Select, Skeleton } from '@/components/ui'
import { ChevronLeft, ChevronRight, FileDown } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { formatMonthKey } from '@/lib/date'
import { useErrText } from '@/lib/err'
import { opsApi, type MonthlyExecutiveReport } from '@/services/opsApi'
import { useMonthlyRevenue } from '@/features/sales/useMonthlyRevenue'
import { MonthlyReportDocument } from './MonthlyReportDocument'
import { printMonthlyReport, releaseMonthlyPrint, watchPrintEnd } from './monthlyPrint'

/** The read plus the three states every Station panel already uses. */
type ReportState = {
  report: MonthlyExecutiveReport | null
  initialLoading: boolean
  error: string | null
  reload: () => void
}

/**
 * One read of the executive summary for `month`.
 *
 * `month` starts empty — the backend then answers for the current Cairo business
 * month — and is only sent once the manager has actually chosen one, so the
 * default can never be a month the browser guessed.
 */
function useMonthlyExecutive(month: string): ReportState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [report, setReport] = useState<MonthlyExecutiveReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    // oxlint-disable-next-line react/set-state-in-effect -- external async read.
    setLoading(true)
    setError(null)
    opsApi
      .monthlyExecutive(month || undefined)
      .then((response) => {
        if (!active) return
        setReport(response)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(errText(cause))
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [month, revision, errText])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { report, initialLoading: loading, error, reload }
}

/**
 * The month the manager is looking at, in the ONE order both navigation
 * controls share.
 *
 * `''` is the backend's current business month and always sorts first — it is
 * the newest thing on the list. Once the report has said which month that
 * actually is, that same month is dropped from the concrete entries, so the
 * current month is never offered (or stepped through) twice.
 */
function useMonthOptions(
  months: readonly { month: string }[],
  selected: string,
  resolved: string,
): string[] {
  return useMemo(() => {
    const keys = [...new Set(months.map((row) => row.month))].sort((l, r) => r.localeCompare(l))
    const withoutCurrent =
      selected === '' && resolved ? keys.filter((key) => key !== resolved) : keys
    return ['', ...withoutCurrent]
  }, [months, selected, resolved])
}

/**
 * One step along the month list.
 *
 * Both controls read the SAME ordered list the select renders, so a step can
 * never land on a month the dropdown does not offer, and each is disabled at
 * the end of that list rather than guessing a neighbouring month with no data.
 * The single chevron is mirrored with `rtl:rotate-180` instead of shipping two
 * glyphs, so previous always points the way the reader reads.
 */
function MonthStep({
  direction,
  label,
  disabled,
  onClick,
}: Readonly<{
  direction: 'previous' | 'next'
  label: string
  disabled: boolean
  onClick: () => void
}>) {
  const Icon = direction === 'previous' ? ChevronRight : ChevronLeft
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0"
    >
      <Icon size={16} aria-hidden className="rtl:rotate-180" />
    </Button>
  )
}

/**
 * The shape of the summary while it loads.
 *
 * It mirrors the document's own sections rather than filling the page with
 * unrelated skeleton cards, so the layout does not jump when the month arrives.
 */
function MonthlyReportSkeleton() {
  return (
    <div
      role="status"
      aria-label="جارٍ تحميل ملخص الشهر"
      className="flex flex-col gap-5 rounded-lg border border-border bg-surface-card p-6"
    >
      <Skeleton variant="text" accessibilityLabel="" className="h-5 w-48" />
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
        <Skeleton variant="rect" accessibilityLabel="" className="h-24 flex-1" />
        <Skeleton variant="rect" accessibilityLabel="" className="h-24 flex-1" />
      </div>
      <Skeleton variant="text" accessibilityLabel="" className="h-4 w-2/3" />
      <Skeleton variant="text" accessibilityLabel="" className="h-4 w-1/2" />
    </div>
  )
}

export function MonthlyReportsPanel() {
  // A cancelled or closed print dialog fires no event in some WebViews, so the
  // class is also cleared when the tab goes away.
  useEffect(() => releaseMonthlyPrint, [])

  const { t, i18n } = useTranslation()
  const toast = useToast()
  // The months that exist are the months the existing monthly report returns;
  // no list of "selectable months" is maintained anywhere in this feature.
  const { report: monthsReport } = useMonthlyRevenue()
  const [month, setMonth] = useState('')
  const { report, initialLoading, error, reload } = useMonthlyExecutive(month)
  const [printing, setPrinting] = useState(false)
  // A second click while the first job is still open would raise a second panel
  // behind the first; the ref is the guard, `printing` is what the reader sees.
  const printingRef = useRef(false)

  const months = monthsReport?.months ?? []
  const options = useMonthOptions(months, month, report?.month ?? '')
  const position = options.indexOf(month)
  const step = (offset: number) => {
    const next = options[position + offset]
    if (next !== undefined) setMonth(next)
  }

  /**
   * Hand the sheet to the platform's print dialog.
   *
   * `printing` rises BEFORE the call so the button is busy for the whole job and
   * lowered only after it ends or fails, so a refused dialog restores the button
   * exactly like a successful one and never leaves the export stuck.
   */
  const exportPdf = async () => {
    if (printingRef.current || !report) return
    printingRef.current = true
    setPrinting(true)
    const stopWatching = watchPrintEnd()
    try {
      await printMonthlyReport()
    } catch {
      releaseMonthlyPrint()
      toast(t('reports.monthly.printError'), 'error')
    } finally {
      stopWatching()
      printingRef.current = false
      setPrinting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading">{t('reports.monthly.tab')}</h2>
        <p className="text-caption">{t('reports.monthly.description')}</p>
      </div>

      {/* The month navigation and the one action this tab exists to offer. Both
          are `print:hidden` because the printed page is the sheet below and
          nothing else. */}
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <MonthStep
          direction="previous"
          label={t('reports.monthly.previousMonth')}
          disabled={position >= options.length - 1}
          onClick={() => step(1)}
        />
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-caption">{t('reports.monthly.selectMonth')}</span>
          <Select
            value={month}
            data-testid="monthly-report-month"
            onChange={(event) => setMonth(event.target.value)}
          >
            {/* The empty option is the CURRENT business month, resolved by the
                backend clock rather than by the browser. */}
            <option value="">{t('reports.monthly.currentMonth')}</option>
            {options.slice(1).map((key) => (
              <option key={key} value={key}>
                {formatMonthKey(key, i18n.language)}
              </option>
            ))}
          </Select>
        </label>
        <MonthStep
          direction="next"
          label={t('reports.monthly.nextMonth')}
          disabled={position <= 0}
          onClick={() => step(-1)}
        />
        <Button
          onClick={exportPdf}
          loading={printing}
          disabled={!report}
          data-testid="monthly-report-print"
          className="print:hidden"
        >
          <FileDown size={16} aria-hidden />
          {t('reports.monthly.print')}
        </Button>
      </div>

      {initialLoading ? (
        <MonthlyReportSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} retryLabel={t('app.retry')} />
      ) : report ? (
        <div className="print-page">
          <MonthlyReportDocument report={report} className="mx-auto max-w-3xl" />
        </div>
      ) : (
        <EmptyState title={t('reports.monthly.empty')} />
      )}
    </div>
  )
}
