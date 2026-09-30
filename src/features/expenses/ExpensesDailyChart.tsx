/**
 * The expenses DAILY bar chart: spend per calendar day, inside the period the
 * Expenses page has selected, split by expense category.
 *
 * It is a CONFIGURATION of the shared `DailyBarChart`, not a second chart, and it
 * is the counterpart of the sales daily chart: same reusable plot, same
 * fullscreen, same export path, same Station colour roles — different business.
 * What stays here is the expenses part:
 *  - the series, which are the REAL categories the backend reported spend for
 *    (never a hardcoded list), and the Arabic `name_ar` each is named by;
 *  - the two states the generic chart deliberately does not own (no spending day
 *    at all, and a single day, which is a fact rather than a movement); and
 *  - the export wiring, which hands the shared exporters their arguments.
 *
 * A DAY OF MANY EXPENSES IS A DIFFERENT BAR, AND ONLY THIS FILE KNOWS WHY
 * ---------------------------------------------------------------------
 * `expenses_overview` already returns, for every day, how many expenses were
 * recorded on it (`COUNT(*)` grouped by `expense_date`). A day of three small
 * spends and a day of one big spend are different facts about the same chart, so
 * the day with two or more wears the companion chart role `expensesMultiple` and
 * a day with one keeps `expenses`. The count itself is printed in the tooltip,
 * so the colour is always explained by the number it came from — and the count
 * is the backend's, never a reading invented here.
 *
 * The data is a PURE RENAME of the DTO. `expenses_overview` already grouped the
 * expenses by day in SQL, so nothing is aggregated here and no total is
 * recomputed: the bar is the day's spend exactly as the backend computed it, and
 * the period filter is the Expenses page's own.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { DailyBarChart } from '@/components/charts/DailyBarChart'
import type {
  DailyBarDatum,
  DailyBarSeries,
  DailyTooltipMetric,
} from '@/components/charts/dailyBar'
import { exportBarChartExcel, exportBarChartPng } from '@/components/charts/barChartExport'
import { Card, MoneyDisplay } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { chartBarColor } from '@/lib/chart-colors'
import { formatDate } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import type { ExpenseOverview } from '@/services/opsApi'

/** Stable id: it namespaces the fullscreen trigger and the chart element. */
export const EXPENSES_DAILY_CHART_ID = 'expenses-daily-by-category'

/** The series key this chart plots. */
export const SPEND_KEY = 'amount'
export const EXPENSES_COUNT_KEY = 'count'
export const AVERAGE_EXPENSE_KEY = 'average_expense'

/** From this many recorded expenses on, a day wears the companion role. */
export const MULTIPLE_EXPENSES_FROM = 2

/**
 * The colour ONE day's spend bar is painted with, decided here and nowhere else.
 *
 * The generic daily chart knows how to draw a bar in whatever centralized colour
 * a datum hands it; it has no idea what an expense count means. This is the
 * adapter's decision, and it is made from the ONE real reading the backend
 * already returns for that day (`expenses_overview` groups by `expense_date`
 * with `COUNT(*)`), never from the total: a day is "multiple" when it recorded
 * two or more expenses, and a day that recorded one is an ordinary day.
 *
 * The two colours are both roles of the same centralized system — `expenses` and
 * its companion `expensesMultiple` — so Dev Settings repaints them together and
 * neither is a literal written into this file. The companion is deliberately a
 * calm, related tone rather than a status colour: several expenses in one day is
 * a normal day's accounting, not a problem to be alarmed about.
 */
// Pure mapping helper, exported for its unit tests beside the chart that draws it.
// oxlint-disable-next-line react/only-export-components
export function expensesBarColor(expenseCount: number | undefined): string | undefined {
  return typeof expenseCount === 'number' && expenseCount >= MULTIPLE_EXPENSES_FROM
    ? chartBarColor('expensesMultiple')
    : undefined
}

/**
 * The one bar this chart draws, and the two figures it states beside it.
 *
 * The spend bar wears the CENTRALIZED `expenses` role — the same role the
 * reports donuts paint المصروفات with — so Dev Settings recolours it with every
 * other bar in the application.
 *
 * The recorded-expense count is a COUNT and the day's average is an AMOUNT, and
 * each says so: that is what keeps a 3-expense day from being printed as
 * `0.03 ج.م`. Neither is a bar — three beside thousands of piastres would be an
 * invisible bar — and neither is invented: both are readings the backend already
 * made for that day, which is how "a day of many small spends" is told apart
 * from "a day of one big spend".
 */
// Pure mapping helper, exported for its unit tests beside the chart that draws it.
// oxlint-disable-next-line react/only-export-components
export function expensesDailyFigures(labels: { total: string; count: string; average: string }): {
  series: DailyBarSeries[]
  metrics: DailyTooltipMetric[]
} {
  return {
    series: [
      { key: SPEND_KEY, label: labels.total, color: chartBarColor('expenses'), type: 'currency' },
    ],
    metrics: [
      { key: EXPENSES_COUNT_KEY, label: labels.count, type: 'count' },
      { key: AVERAGE_EXPENSE_KEY, label: labels.average, type: 'currency' },
    ],
  }
}

/**
 * Backend day rows → chart days, ascending by day.
 *
 * `label` and `fullLabel` are both produced by the CENTRAL date formatter, so the
 * axis and the tooltip are Arabic and formatted, and a raw `YYYY-MM-DD` is never
 * shown to a reader. The rows are already ascending; sorting defensively costs
 * nothing and guarantees a chronological axis whatever the backend returns.
 *
 * The day's average expense is its own spend over its own count, rounded to a
 * piastre — the same division the Expenses KPI band already performs for the
 * whole period. A day with no recorded expense has no average, so the key is
 * left off the day entirely and the tooltip prints no average row for it rather
 * than a `0.00` nobody measured.
 */
// Pure DTO mapping, exported for its unit tests beside the chart that draws it.
// oxlint-disable-next-line react/only-export-components
export function toExpensesDailyData(
  rows: readonly ExpenseOverview['days'][number][],
): DailyBarDatum[] {
  return [...rows]
    .sort((left, right) => left.day_date.localeCompare(right.day_date))
    .map((row) => ({
      label: formatDate(row.day_date),
      fullLabel: formatDate(row.day_date),
      [SPEND_KEY]: row.amount,
      [EXPENSES_COUNT_KEY]: row.count,
      ...(row.count > 0 ? { [AVERAGE_EXPENSE_KEY]: Math.round(row.amount / row.count) } : {}),
      // The day names its own bar colour, from its OWN recorded count — never
      // from the total. A day with one expense simply says nothing and keeps the
      // series' `expenses` role, so the two are decided by the same rule and the
      // distinction cannot drift from the number the tooltip prints.
      color: expensesBarColor(row.count),
    }))
}

export function ExpensesDailyChart({
  overview,
  period,
  className,
}: {
  readonly overview: ExpenseOverview
  /** The page's selected period, stated on the card and in the export. */
  readonly period: string
  readonly className?: string
}) {
  const { t } = useTranslation()
  const toast = useToast()

  const data = useMemo(() => toExpensesDailyData(overview.days), [overview.days])
  // One declaration of what the chart plots and what it states, localized once.
  const { series, metrics } = useMemo(
    () =>
      expensesDailyFigures({
        total: t('expenses.kpi.total'),
        count: t('expenses.kpi.count'),
        average: t('expenses.kpi.average'),
      }),
    [t],
  )
  // The workbook carries the day's spend and the day's recorded count as two
  // declared columns of two declared types; the exporter resolves both from those
  // declarations, so a count can no longer arrive in the sheet divided by 100.
  const exportSeries = useMemo(
    () => [
      ...series,
      {
        key: EXPENSES_COUNT_KEY,
        label: t('expenses.kpi.count'),
        color: chartBarColor('secondary'),
        type: 'count' as const,
      },
    ],
    [series, t],
  )

  const title = t('expenses.trend.title')
  const description = t('expenses.trend.hint')

  if (data.length === 0) {
    return (
      <Card className={className}>
        <TrendHeading />
        <p className="py-6 text-center text-body text-foreground-muted">
          {t('expenses.trend.empty')}
        </p>
      </Card>
    )
  }

  // One spending day is a fact, not a trend.
  if (data.length === 1) {
    const day = overview.days[0]
    return (
      <Card className={className}>
        <TrendHeading />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-caption text-foreground-subtle">
              {t('expenses.trend.singleDay', { date: formatDate(day.day_date) })}
            </p>
            <MoneyDisplay
              amount={day.amount}
              variant="auto"
              className="text-2xl font-extrabold text-foreground-strong"
            />
          </div>
          <p className="text-caption text-foreground-muted">
            {t('expenses.trend.expensesOn', { count: day.count })}
          </p>
        </div>
      </Card>
    )
  }

  // The SAME exporters the reports charts use, with the same argument shape, the
  // same Station workbook layout and the same filename convention.
  const buildExport = () => ({
    title,
    description,
    period,
    data,
    series: exportSeries,
    summary: [{ label: t('reports.charts.total'), value: formatMinorMoney(overview.total_amount) }],
    categoryHeader: t('expenses.trend.dayColumn'),
    filename: 'station-expenses-daily',
  })

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
    <DailyBarChart
      id={EXPENSES_DAILY_CHART_ID}
      className={className}
      title={title}
      description={description}
      period={period}
      data={data}
      // The spend bar wears the CENTRALIZED `expenses` role — the same role the
      // reports donuts paint المصروفات with — so Dev Settings recolours it with
      // every other bar in the application.
      series={series}
      // The recorded-expense count and the day's average are real readings of the
      // day that must not be BARS, and each is stated in its own type.
      metrics={metrics}
      dateLabel={t('expenses.trend.dateLabel')}
      // The chart reads the peak day out of the very data the bars are drawn
      // from, so the two can never disagree; the page supplies only the Arabic
      // words, and the chart states them in a strong hand.
      peakLabel={t('expenses.trend.peakLabel')}
      onExportPng={downloadPng}
      onExportExcel={downloadExcel}
    />
  )
}

function TrendHeading() {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="text-section text-foreground-strong">{t('expenses.trend.title')}</h2>
        <p className="mt-0.5 text-caption text-foreground-subtle">{t('expenses.trend.hint')}</p>
      </div>
    </div>
  )
}
