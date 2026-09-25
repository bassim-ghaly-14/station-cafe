/**
 * Print status — the operational view of the printing pipeline.
 *
 * Read-only presentation: it lists the print jobs the printing service already
 * recorded (`list_print_jobs`), reports the printer configuration
 * (`get_print_config`) and can trigger the existing test print. No printing
 * logic, no SQL and no state of its own lives here, and no technical identifier
 * (document type, job status or error code) is ever rendered — see
 * `@/lib/print-presentation` for the mapping layer.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, Button, Card, CardHeader, TableSkeleton } from '@/components/ui'
import { DisplayDateTime } from '@/components/ui/display-datetime'
import { Printer, RefreshCw } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import {
  printDocumentLabel,
  printDocumentPresentation,
  printJobErrorMessage,
  printErrorText,
  printJobStatusPresentation,
  printerIsConfigured,
} from '@/lib/print-presentation'
import { opsApi, type PrintConfig, type PrintJobRow } from '@/services/opsApi'

/** Recent jobs shown; the printing service clamps the limit to 1..200. */
const RECENT_JOBS_LIMIT = 30

export function PrintStatusPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [jobs, setJobs] = useState<PrintJobRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // null = configuration not read (or unreadable): no printer state is claimed.
  const [printer, setPrinter] = useState<PrintConfig | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(() => {
    setLoadError(null)
    opsApi
      .printJobs(RECENT_JOBS_LIMIT)
      .then(setJobs)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
    // Configuration is informational: if it cannot be read, the notice stays
    // hidden instead of blocking the job history.
    opsApi
      .printConfig()
      .then(setPrinter)
      .catch(() => setPrinter(null))
  }, [errText, toast])

  useEffect(() => {
    load()
  }, [load])

  /** Existing test print command — duplicate protection stays backend-owned. */
  async function testPrint() {
    setTesting(true)
    try {
      const outcome = await opsApi.printTest()
      toast(
        outcome.duplicate_suppressed ? t('print.duplicateSuppressed') : t('print.done'),
        'success',
      )
      load()
    } catch (e) {
      toast(printErrorText(t, e), 'error')
    } finally {
      setTesting(false)
    }
  }

  const notConfigured = printer !== null && !printerIsConfigured(printer)

  return (
    <div className="flex flex-col gap-3">
      {/* Printer configuration problem ≠ print failure: it is reported once,
          separately from the jobs, and never as a failed job reason. */}
      {notConfigured ? (
        <div className="flex items-start gap-3 rounded-md border border-warning-border bg-warning-soft p-3 text-warning-foreground">
          <Printer size={18} aria-hidden className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-bold">{t('print.error.notConfigured')}</p>
            <p className="mt-0.5 text-sm">{t('print.printer.notConfiguredHint')}</p>
          </div>
        </div>
      ) : null}

      {/* Existing operations only: send the test page, reload the recorded
          jobs. No per-job retry exists in the printing service, so none is
          offered here. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void testPrint()} loading={testing}>
          {!testing ? <Printer size={16} aria-hidden /> : null}
          {t('print.testPrint')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('print.refresh')}
          title={t('print.refresh')}
          onClick={load}
          disabled={testing}
        >
          <RefreshCw size={16} aria-hidden />
        </Button>
      </div>

      {jobs === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <TableSkeleton rows={5} columns={3} />
        )
      ) : jobs.length === 0 ? (
        <EmptyState title={t('print.empty')} />
      ) : (
        <Card>
          <CardHeader title={t('print.statusTitle')} subtitle={t('print.statusSubtitle')} />
          <div className="flex flex-col divide-y divide-border-subtle">
            {jobs.map((job) => (
              <PrintJobItem key={job.id} job={job} />
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

/**
 * One recorded print job: human-readable document name, status badge (color +
 * icon + label, so color is never the only signal), when it happened, how many
 * attempts, and — on failure — the localized reason. The raw backend error stays
 * in the database for diagnostics and is never rendered.
 */
function PrintJobItem({ job }: { job: PrintJobRow }) {
  const { t } = useTranslation()
  const document = printDocumentPresentation(job.doc_type)
  const status = printJobStatusPresentation(job.status)
  const DocumentIcon = document.icon
  const message = printJobErrorMessage(t, job)

  return (
    <div className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-muted text-foreground-muted"
      >
        <DocumentIcon size={18} />
      </span>

      <div className="min-w-48 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-body font-bold text-foreground-strong">
            {printDocumentLabel(t, job.doc_type)}
          </span>
          <Badge variant={status.variant} size="sm" icon={status.icon} dot>
            {t(status.labelKey)}
          </Badge>
        </p>

        <p className="text-caption mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <DisplayDateTime value={job.created_at} separator="" />
          <span aria-hidden className="shrink-0 text-foreground-faint select-none">
            ·
          </span>
          <span>
            {t('print.jobNumber')}{' '}
            <span className="tabular-nums" dir="ltr">
              #{job.id}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-foreground-faint select-none">
            ·
          </span>
          <span>
            {t('print.attempts')}: <span className="tabular-nums">{job.attempts}</span>
          </span>
        </p>

        {message ? (
          <p className="mt-1 text-sm font-medium text-destructive">{message}</p>
        ) : status.hintKey ? (
          <p className="text-caption mt-1">{t(status.hintKey)}</p>
        ) : null}
      </div>
    </div>
  )
}
