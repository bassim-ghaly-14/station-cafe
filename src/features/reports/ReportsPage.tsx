/**
 * Manager reports UI — the reporting surface: the operations log, print job
 * history, the shift/day closings and the analytics charts.
 *
 * SCOPE CHANGE: this page used to also carry "مبيعات اليوم" and "مبيعات الأصناف".
 * Both moved to the dedicated Sales workspace (`/sales`), which is now the
 * single source of truth for sales, so they are NOT re-implemented here: two
 * sales reports would be two sets of financial rules. What remains below is
 * reporting that has no sales-management equivalent — the audit trail, the
 * printer, the closings and the exportable charts.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import {
  Button,
  Card,
  CardHeader,
  ChartGridSkeleton,
  DateRangePicker,
  EmployeeAvatar,
  MoneyDisplay,
} from '@/components/ui'
import { BarChart3 } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { DisplayDate, DisplayDateTimeRange } from '@/components/ui/display-datetime'
import { addDays, formatDate, todayIso } from '@/lib/date'
import { cn } from '@/lib/utils'
import { opsApi } from '@/services/opsApi'
import type { ClosedBusinessDay } from '@/services/opsApi'
import { useErrText } from '@/lib/err'
import { useAnalyticsCharts, type AnalyticsChart } from './charts/analyticsCharts'
import { AnalyticsDonutChart } from './charts/AnalyticsDonutChart'
import { ChartEmptyReasons, ChartEmptyState } from './charts/ChartEmptyState'
import { MonthlyComparisonSection } from './charts/MonthlyComparisonSection'
import { OperationHistoryPanel } from './audit/OperationHistoryPanel'
import { ProgressBar } from '@/components/ui/progress-bar'
import { PrintPreviewDialog, type PrintPreviewTarget } from '@/features/pos/PrintPreviewDialog'
import { PrintStatusPanel } from '@/features/printing/PrintStatusPanel'
import type { ShiftRow } from '@/services/shiftApi'

type Tab = 'audit' | 'print' | 'shiftClosings' | 'dayClosings' | 'charts'
const RANGE_KEY = 'station.reports.dateRange'

function initialRange(): { from: string; to: string } {
  try {
    const stored = localStorage.getItem(RANGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as { from?: unknown; to?: unknown }
      return {
        from: typeof parsed.from === 'string' ? parsed.from : '',
        to: typeof parsed.to === 'string' ? parsed.to : '',
      }
    }
  } catch {
    /* fall back to the product's initial seven-day default */
  }
  const today = todayIso()
  return { from: addDays(today, -6), to: today }
}

export default function ReportsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('audit')
  const [{ from, to }, setRange] = useState(initialRange)
  useEffect(() => {
    localStorage.setItem(RANGE_KEY, JSON.stringify({ from, to }))
  }, [from, to])

  const setFrom = (value: string) => setRange((current) => ({ ...current, from: value }))
  const setTo = (value: string) => setRange((current) => ({ ...current, to: value }))

  const TABS: { id: Tab; label: string }[] = [
    { id: 'audit', label: t('nav.audit') },
    { id: 'print', label: t('reports.printJobs') },
    { id: 'shiftClosings', label: t('reports.shiftClosings') },
    { id: 'dayClosings', label: t('reports.dayClosings') },
    { id: 'charts', label: t('reports.charts.title') },
  ]

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-heading flex items-center gap-2">
            <BarChart3 size={22} aria-hidden />
            {t('nav.reports')}
          </h1>
          <p className="mt-0.5 text-caption text-foreground-subtle">{t('reports.subtitle')}</p>
        </div>
      </header>

      {/*
        The tab strip.

        On a desktop this is the row of buttons it always was. Below `sm` it
        becomes a single horizontally scrollable LINE rather than a wrapped
        block, and that is a deliberate choice rather than a concession:

        - five Arabic tab labels at `size="sm"` need roughly 420px on one line,
          which no phone has, so `flex-wrap` produced two ragged rows of
          three-and-two with a selected tab that could sit alone;
        - a tab strip is a NAVIGATION, and a navigation that reflows while the
          user reads it is disorienting in a way a horizontally scrollable strip
          is not — the selected tab stays where it was;
        - `overscroll-x-contain` keeps a horizontal swipe that reaches the end
          of the strip from being handed to the page, so the strip does not turn
          into "the whole screen slid sideways".

        The negative inline margins + matching padding bleed the strip to the
        screen edge on a phone so the cut-off tab reads as "there is more this
        way" rather than as a clipped layout, while its FIRST tab still lines up
        with the rest of the page. The `sm:` reset puts desktop back exactly.
      */}
      <div
        className="-mx-3 flex gap-2 overflow-x-auto overscroll-x-contain px-3 sm:mx-0 sm:flex-wrap sm:overflow-x-visible sm:px-0"
        role="tablist"
        aria-label={t('nav.reports')}
      >
        {TABS.map((x) => (
          <Button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            variant={tab === x.id ? 'default' : 'ghost'}
            size="sm"
            // `shrink-0` so a long label is never compressed into an ellipsis
            // by a narrower neighbour; the strip scrolls instead.
            className="shrink-0"
            onClick={() => setTab(x.id)}
          >
            {x.label}
          </Button>
        ))}
      </div>

      {tab === 'audit' ? <OperationHistoryPanel /> : null}
      {tab === 'print' ? <PrintStatusPanel /> : null}
      {tab === 'shiftClosings' ? (
        <ClosingReports kind="shift" from={from} to={to} setFrom={setFrom} setTo={setTo} />
      ) : null}
      {tab === 'dayClosings' ? (
        <ClosingReports kind="day" from={from} to={to} setFrom={setFrom} setTo={setTo} />
      ) : null}
      {tab === 'charts' ? (
        <ChartsReport from={from} to={to} setFrom={setFrom} setTo={setTo} />
      ) : null}
    </div>
  )
}

/**
 * The analytics view.
 *
 * The four states are deliberately distinct and none of them can be mistaken for
 * another:
 *
 *  - first load   → chart-shaped skeletons, because a chart grid is not a table;
 *  - error        → the failure, with a retry, and no charts behind it;
 *  - empty        → the chart empty state, which still looks like a chart;
 *  - refreshing   → the previous charts stay on screen, dimmed, under a
 *                   progress hairline, instead of collapsing to a skeleton
 *                   every time the period changes.
 */
function ChartsReport({
  from,
  to,
  setFrom,
  setTo,
}: {
  readonly from: string
  readonly to: string
  readonly setFrom: (v: string) => void
  readonly setTo: (v: string) => void
}) {
  const report = useAnalyticsCharts(from, to)
  const { t } = useTranslation()
  const errorText = useErrText(t)
  const scope = t('reports.charts.period', { period: `${formatDate(from)} — ${formatDate(to)}` })

  return (
    <div className="flex flex-col gap-4">
      <RangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />

      {report.initialLoading ? (
        <ChartGridSkeleton charts={3} />
      ) : report.error ? (
        <ErrorState
          message={errorText(report.error)}
          onRetry={report.reload}
          retryLabel={t('app.retry')}
        />
      ) : report.data.length === 0 ? (
        <div className="flex flex-col gap-5">
          <ChartEmptyState scope={scope} hint={t('reports.charts.emptyHint')} />
          <ChartEmptyReasons />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {report.refreshing ? <ProgressBar label={t('app.loading')} /> : null}
          <div
            className={cn(
              'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3',
              report.refreshing && 'opacity-60 transition-opacity',
            )}
            aria-busy={report.refreshing || undefined}
            data-testid="analytics-charts-grid"
          >
            {report.data.map((chart) =>
              chart.hasData ? (
                <AnalyticsDonutChart key={chart.id} chart={chart} from={from} to={to} />
              ) : (
                <EmptyChartCard key={chart.id} chart={chart} scope={scope} />
              ),
            )}
          </div>
        </div>
      )}

      {/* The CALENDAR comparisons live in their own section BELOW the
          period-scoped charts, and deliberately outside the branch above: they
          state their own trailing window through their own commands, so the
          period picker here never re-reads or re-shapes them — and they keep
          their own loading/empty/error states rather than borrowing the
          analytics report's. */}
      <MonthlyComparisonSection />
    </div>
  )
}

/**
 * The card heading shared by a populated chart and its empty variant, so a card
 * never changes identity just because the period has no numbers in it.
 */
function ChartCardHeading({ chart }: Readonly<{ readonly chart: AnalyticsChart }>) {
  const { t } = useTranslation()
  const Icon = chart.icon
  return (
    <div className="flex items-start gap-3 p-5 pb-4">
      <span className="flex size-10 shrink-0 items-center justify-center bg-accent text-primary">
        <Icon size={19} aria-hidden />
      </span>
      <div className="min-w-0">
        <h2 className="text-section text-start">{t(`reports.charts.${chart.titleKey}`)}</h2>
        <p className="mt-0.5 text-caption">{t(`reports.charts.${chart.descriptionKey}`)}</p>
      </div>
    </div>
  )
}

/**
 * Report period filter — one shared range control for the `from` / `to` pair the
 * report services already expect. The values travel to the API untouched:
 * `YYYY-MM-DD` strings, empty when the user clears the period.
 */
function RangePicker({
  from,
  to,
  setFrom,
  setTo,
}: {
  readonly from: string
  readonly to: string
  readonly setFrom: (v: string) => void
  readonly setTo: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangePicker
        from={from}
        to={to}
        onChange={({ from: nextFrom, to: nextTo }) => {
          setFrom(nextFrom)
          setTo(nextTo)
        }}
      />
    </div>
  )
}

function ClosingReports({
  kind,
  from,
  to,
  setFrom,
  setTo,
}: {
  readonly kind: 'shift' | 'day'
  readonly from: string
  readonly to: string
  readonly setFrom: (v: string) => void
  readonly setTo: (v: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [shifts, setShifts] = useState<ShiftRow[]>([])
  const [days, setDays] = useState<import('@/services/opsApi').ClosedBusinessDay[]>([])
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<PrintPreviewTarget | null>(null)
  const load = useCallback(() => {
    setError(null)
    const request =
      kind === 'shift'
        ? opsApi.closedShifts(from || undefined, to || undefined)
        : opsApi.closedBusinessDays(from || undefined, to || undefined)
    request
      .then((rows) =>
        kind === 'shift'
          ? setShifts(rows as ShiftRow[])
          : setDays(rows as import('@/services/opsApi').ClosedBusinessDay[]),
      )
      .catch((e) => {
        setError(errText(e))
        toast(errText(e), 'error')
      })
  }, [kind, from, to, errText, toast])
  useEffect(() => {
    load()
  }, [load])
  return (
    <div className="flex flex-col gap-3">
      <RangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {error ? (
        <ErrorState message={error} onRetry={load} retryLabel={t('app.retry')} />
      ) : kind === 'shift' ? (
        <ShiftClosings shifts={shifts} onPreview={setTarget} />
      ) : (
        <DayClosings days={days} onPreview={setTarget} />
      )}
      {target ? <PrintPreviewDialog target={target} onClose={() => setTarget(null)} /> : null}
    </div>
  )
}

/**
 * A chart in the grid that has nothing to plot for this period.
 *
 * The card keeps the chart's own heading, so the grid does not reflow and a
 * reader can still tell WHICH measure is empty — an empty card and a missing
 * card are different facts. The reason is stated in words inside it rather than
 * left as an empty box.
 */
function EmptyChartCard({
  chart,
  scope,
}: Readonly<{ readonly chart: AnalyticsChart; readonly scope: string }>) {
  const { t } = useTranslation()
  return (
    <Card
      className="flex min-h-88 flex-col p-0 shadow-none"
      data-testid={`empty-chart-${chart.id}`}
    >
      <ChartCardHeading chart={chart} />
      <div className="flex flex-1 items-center justify-center border-t border-border-subtle p-4">
        <ChartEmptyState
          compact
          headingLevel="h3"
          scope={scope}
          title={t('reports.charts.emptyChartTitle')}
          body={t('reports.charts.emptyChartBody')}
          className="border-0 bg-transparent p-0"
        />
      </div>
    </Card>
  )
}

/**
 * The closed shifts in the range.
 *
 * A shift is identified by the person who ran it, so the row leads with the
 * cashier's avatar and name; the expected cash is the figure the closing is
 * about, and the window is when it was open. Every row previews the EXISTING
 * shift report through the shared dialog.
 */
function ShiftClosings({
  shifts,
  onPreview,
}: Readonly<{
  shifts: readonly ShiftRow[]
  onPreview: (target: PrintPreviewTarget) => void
}>) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader title={t('reports.shiftClosings')} />
      <div className="divide-y divide-border-subtle">
        {shifts.map((s) => (
          // `flex-col` below `sm`: the shift's identity, its window and its
          // expected cash need the full width on a phone, and a `flex-wrap` row
          // left the preview button on a line of its own at a random width.
          // `sm:flex-row` is the original single line.
          <div key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0 flex-1 sm:min-w-48">
              <p className="flex min-w-0 items-center gap-1.5 font-bold">
                <span className="tabular-nums">#{s.id}</span>
                <span aria-hidden>·</span>
                <EmployeeAvatar role={s.user_role} size="sm" />
                <span className="truncate">{s.user_name ?? '—'}</span>
              </p>
              <p className="min-w-0 text-caption">
                <DisplayDateTimeRange from={s.opened_at} to={s.closed_at} />
              </p>
              <MoneyDisplay amount={s.expected_cash} />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="sm:ms-auto"
              onClick={() => onPreview({ kind: 'shift_report', shift_id: s.id })}
            >
              {t('reports.preview')}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  )
}

/**
 * The closed business days in the range.
 *
 * A day is a whole day, so its row carries the date, the window it was open,
 * and how many shifts it contained alongside the day's total sales.
 */
function DayClosings({
  days,
  onPreview,
}: Readonly<{
  days: readonly ClosedBusinessDay[]
  onPreview: (target: PrintPreviewTarget) => void
}>) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader title={t('reports.dayClosings')} />
      <div className="divide-y divide-border-subtle">
        {days.map((d) => (
          // The same phone treatment as the shift rows above, for the same
          // reason: identity, window and totals need the full width below `sm`.
          <div
            key={d.business_day_id}
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1 sm:min-w-48">
              <p className="font-bold">
                <span className="tabular-nums">#{d.business_day_id}</span> ·{' '}
                <DisplayDate value={d.day_date} />
              </p>
              <p className="min-w-0 text-caption">
                <DisplayDateTimeRange from={d.opened_at} to={d.closed_at} />
              </p>
              <p>
                {d.shift_count} · <MoneyDisplay amount={d.totals.total_sales} />
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="sm:ms-auto"
              onClick={() => onPreview({ kind: 'day_report', day_id: d.business_day_id })}
            >
              {t('reports.preview')}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  )
}
