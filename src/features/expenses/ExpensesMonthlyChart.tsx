/**
 * The monthly expenses chart: total spend per month, split by expense
 * category.
 *
 * RENDERED FROM Reports → Charts, in the "المبيعات والمصروفات الشهرية" section
 * (`reports/charts/MonthlyComparisonSection`), below the period-scoped analytics
 * charts. It used to sit on the Expenses page; it moved here whole, beside the
 * sales monthly chart, because both are the same CALENDAR comparison over the
 * same Dev-Settings window. Nothing in this component changed with the move.
 *
 * It is the SECOND USAGE of the generic `MonthlyComparisonBarChart` and it
 * follows the Sales monthly chart's production pattern: the same reusable chart,
 * the same Dev-Settings-derived window, the same three states, the same export
 * wiring and the same fullscreen affordance. Only the business meaning differs —
 * where Sales plots two comparable lines side by side, this plots the COMPOSITION
 * of one total, so it asks for the same chart in its `stacked` layout: one bar per
 * month, one coloured segment per category inside it.
 *
 * It owns:
 *  - the data read (its own command, its own trailing calendar window, and
 *    deliberately NOT any page's date picker — see `useMonthlyExpenses`);
 *  - the localized title, labels and period line;
 *  - the three states (loading, failure, empty) in the same shapes the sales
 *    monthly chart uses; and
 *  - the export wiring, which hands the chart the existing PNG/Excel exporters
 *    and reports the outcome through the shared toast.
 *
 * The chart below it stays business-agnostic and was NOT modified: swap `series`
 * and `data` and the same component would plot anything.
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
import { formatCompact, monthlyExpenseSeries, toMonthlyExpenseData } from './monthlyExpenses'
import { useMonthlyExpenses } from './useMonthlyExpenses'

export const MONTHLY_EXPENSES_CHART_ID = 'expenses-monthly-by-category'
/** The recharts stack identity of the expense segments inside one monthly bar. */
export const MONTHLY_EXPENSES_STACK_ID = 'expenses'

export function ExpensesMonthlyChart({ className }: Readonly<{ readonly className?: string }>) {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const { window, initialLoading, error, reload } = useMonthlyExpenses()
  const report = window?.report

  // The series come from the report's own category list — the domain decides
  // which bars exist, never a hardcoded list in the UI.
  const series = useMemo(() => monthlyExpenseSeries(report ?? { categories: [] }), [report])
  // The rows are already aggregated by the backend; this only labels them, and
  // only when the response or the language changes.
  const data = useMemo(
    () => toMonthlyExpenseData(report ?? { months: [] }, series, i18n.language),
    [report, series, i18n.language],
  )

  const title = t('expenses.monthly.title')
  const description = t('expenses.monthly.description')
  // The raw window, for the exporters (they print their own period label), and
  // the labelled one for the card.
  const period = window ? `${formatDate(window.from)} — ${formatDate(window.to)}` : ''
  const scope = window ? t('reports.charts.period', { period }) : ''

  const buildExport = (): BarChartExport => ({
    title,
    description,
    period,
    data,
    series,
    layout: 'stacked',
    summary: [
      {
        label: t('reports.charts.total'),
        value: formatMinorMoney(data.reduce((sum, row) => sum + monthTotal(row, series), 0)),
      },
    ],
    categoryHeader: t('expenses.monthly.monthColumn'),
    filename: 'station-expenses-monthly',
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
  // empty on its own. A month with no spend is also kept — one such month is a
  // fact that still plots, and only a period with nothing in it has no chart.
  if (!hasMonthlyValues(data, series)) {
    return (
      <Card className={className} data-testid="monthly-chart-empty">
        <h2 className="text-section text-foreground-strong">{title}</h2>
        <p className="mt-0.5 text-caption text-foreground-subtle">{description}</p>
        <ChartEmptyState
          compact
          headingLevel="h3"
          scope={scope}
          title={t('expenses.monthly.emptyTitle')}
          body={t('expenses.monthly.emptyBody')}
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
      id={MONTHLY_EXPENSES_CHART_ID}
      title={title}
      description={description}
      period={scope}
      data={data}
      series={series}
      // ONE bar per month, split into coloured segments by expense category: the
      // bar's height is the month's total spend and the segments are how that
      // total is made up. NOT a side-by-side comparison of the categories — the
      // categories are not rivals, they are parts of the same month's spend.
      layout="stacked"
      stackId={MONTHLY_EXPENSES_STACK_ID}
      formatValue={formatCompact}
      // The indicator is the TOTAL of every category against the previous
      // month's total — "the spend went up / down", never "category A beat
      // category B", and never a judgement about whether that is good.
      comparisonLabel={t('expenses.monthly.vsPrevious')}
      comparisonUnavailableLabel={t('expenses.monthly.noComparison')}
      onExportPng={downloadPng}
      onExportExcel={downloadExcel}
      className={className}
    />
  )
}
