/**
 * The monthly sales comparison: Cafe vs Wash.
 *
 * RENDERED FROM Reports → Charts, in the "المبيعات والمصروفات الشهرية" section
 * (`reports/charts/MonthlyComparisonSection`), below the period-scoped
 * analytics charts. It used to sit on the Sales page; it moved here whole,
 * because a CALENDAR comparison is reporting, not a filtered slice of the
 * sales period. The component itself is unchanged by the move: it still owns
 * the data read, the labels, the three states and the export wiring, and it
 * still takes its window from Dev Settings rather than from any page filter.
 *
 * This is the FIRST USAGE of the generic `MonthlyComparisonBarChart`, and it is
 * the only file that connects that chart to Station's business meaning. It owns:
 *  - the data read (its own command, its own trailing calendar window, and
 *    deliberately NOT any page's date picker — see `useMonthlyRevenue`);
 *  - the localized title, labels and period line;
 *  - the three states (loading, failure, empty) in the same shapes the reports
 *    charts use; and
 *  - the export wiring, which hands the chart the existing PNG/Excel exporters
 *    and reports the outcome through the shared toast.
 *
 * The chart below it stays business-agnostic: swap `series` and `data` and the
 * same component would plot Cash vs Card or this year vs last year.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import { Card, ChartCardSkeleton } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { MonthlyComparisonBarChart } from '@/components/charts/MonthlyComparisonBarChart'
import { hasMonthlyValues, monthTotal } from '@/components/charts/monthlyComparison'
import {
  exportBarChartExcel,
  exportBarChartPng,
  type BarChartExport,
} from '@/components/charts/barChartExport'
import { ChartEmptyState } from '@/features/reports/charts/ChartEmptyState'
import { formatDate } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import { formatCompact, monthlyRevenueSeries, toMonthlyRevenueData } from './monthlyRevenue'
import { useMonthlyRevenue } from './useMonthlyRevenue'

export const MONTHLY_REVENUE_CHART_ID = 'sales-monthly-cafe-wash'

export function SalesMonthlyRevenueChart({ className }: Readonly<{ readonly className?: string }>) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const { report, initialLoading, error, reload } = useMonthlyRevenue()

  const series = useMemo(
    () => monthlyRevenueSeries({ cafe: t('catalog.CAFE'), wash: t('catalog.WASH') }),
    [t],
  )
  // The rows are already aggregated by the backend; this only labels them, and
  // only when the response changes.
  const data = useMemo(
    () => toMonthlyRevenueData(report?.months ?? [], i18n.language),
    [report, i18n.language],
  )

  const title = t('sales.monthly.title')
  const description = t('sales.monthly.description')
  // The raw window, for the exporters (they print their own period label), and
  // the labelled one for the card.
  const period = report ? `${formatDate(report.from)} — ${formatDate(report.to)}` : ''
  const scope = report ? t('reports.charts.period', { period }) : ''

  const buildExport = (): BarChartExport => ({
    title,
    description,
    period,
    data,
    series,
    summary: [
      {
        label: t('reports.charts.total'),
        value: formatMinorMoney(data.reduce((sum, row) => sum + monthTotal(row, series), 0)),
      },
    ],
    categoryHeader: t('sales.monthly.monthColumn'),
    filename: 'station-cafe-vs-wash-monthly',
  })

  if (initialLoading) return <ChartCardSkeleton className={className} />
  if (error) {
    return (
      <div className={className}>
        <ErrorState message={error} onRetry={reload} retryLabel={t('app.retry')} />
      </div>
    )
  }
  // "No data" is the WHOLE configured window being valueless, not one quiet
  // month: the backend keeps a trading month as a zero row, so `data` is never
  // empty on its own. A month with no invoices is also kept — one such month is
  // a fact that still plots, and only a period with nothing in it has no chart.
  if (!hasMonthlyValues(data, series)) {
    return (
      <Card className={className} data-testid="monthly-chart-empty">
        <h2 className="text-section text-foreground-strong">{title}</h2>
        <p className="mt-0.5 text-caption text-foreground-subtle">{description}</p>
        <ChartEmptyState
          compact
          headingLevel="h3"
          scope={scope}
          title={t('sales.monthly.emptyTitle')}
          body={t('sales.monthly.emptyBody')}
          className="mt-3 border-0 bg-transparent p-0"
        />
      </Card>
    )
  }

  const downloadPng = async () => {
    try {
      await exportBarChartPng(buildExport())
      toast(t('reports.charts.exportedPng'), 'success')
    } catch {
      toast(t('reports.charts.exportError'), 'error')
    }
  }
  const downloadExcel = () => {
    try {
      exportBarChartExcel(buildExport())
      toast(t('reports.charts.exportedExcel'), 'success')
    } catch {
      toast(t('reports.charts.exportError'), 'error')
    }
  }

  return (
    <MonthlyComparisonBarChart
      id={MONTHLY_REVENUE_CHART_ID}
      title={title}
      description={description}
      period={scope}
      data={data}
      series={series}
      formatValue={formatCompact}
      // Cafe and Wash are two PARTS of one monthly revenue, so the tooltip states
      // their sum as well. The figure is the hovered month's `cafe_sales +
      // wash_sales` read through the chart's own `monthTotal` — the same total the
      // month-over-month indicator already compares — so it is computed from the
      // values actually on screen and never from a separate source.
      showTotal
      comparisonLabel={t('sales.monthly.vsPrevious')}
      comparisonUnavailableLabel={t('sales.monthly.noComparison')}
      onExportPng={downloadPng}
      onExportExcel={downloadExcel}
      className={className}
    />
  )
}
