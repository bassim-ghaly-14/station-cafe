/**
 * The sales DAILY bar chart: revenue per calendar day, inside the period the
 * Sales page has selected.
 *
 * It is a CONFIGURATION of the shared `DailyBarChart`, not a second chart. The
 * reusable component owns the plot, the axes, the fullscreen dialog and the
 * export menu; this file owns only what is sales-specific:
 *  - which two series are plotted, and their Station colour roles;
 *  - the Arabic labels those series are named by in the tooltip;
 *  - the two states the generic chart deliberately does not own (no days at all,
 *    and a single day, which has no movement to show); and
 *  - the export wiring, which hands the shared exporters their arguments and
 *    reports the outcome through the shared toast.
 *
 * The data is a PURE RENAME of the DTO. `sales_overview` already grouped the
 * invoices by day in SQL, so nothing is aggregated here: the bar height is
 * `total_sales` exactly as the backend computed it, and the day is the day the
 * backend returned. The period filter is the Sales page's own — this chart
 * re-reads nothing and knows no date of its own.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { DailyBarChart } from '@/components/charts/DailyBarChart'
import {
  dayTotal,
  type DailyBarDatum,
  type DailyBarSeries,
  type DailyTooltipMetric,
} from '@/components/charts/dailyBar'
import { exportBarChartExcel, exportBarChartPng } from '@/components/charts/barChartExport'
import { Card, MoneyDisplay } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { chartBarColor } from '@/lib/chart-colors'
import { formatDate } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import type { SalesDayRow } from '@/services/salesApi'

/** Stable id: it namespaces the fullscreen trigger and the chart element. */
export const SALES_DAILY_CHART_ID = 'sales-daily-revenue'

/** The series keys this chart plots, in the order the bars appear. */
export const REVENUE_KEY = 'total_sales'
export const INVOICES_KEY = 'invoices_count'
export const AVERAGE_INVOICE_KEY = 'average_invoice'

/**
 * The one bar this chart draws, and the two figures it states beside it.
 *
 * `revenue` is the CENTRALIZED chart bar role (`lib/chart-colors.ts`) — the same
 * role the reports donuts paint المبيعات with — so the bar a manager sees here
 * is the same bar role they can recolour in Dev Settings, and light and dark mode
 * remain the theme's decision.
 *
 * The invoice count is a COUNT and the average is an AMOUNT, and each says so:
 * that is what keeps a 42-invoice day from ever being printed as `0.42 ج.م`.
 * Neither is a bar — two invoices beside 24,000 piastres would be an invisible
 * bar — and neither is decoration: both are readings the backend already made
 * for that day, and "many small tickets" against "one big ticket" is a real
 * distinction the manager opens this chart for.
 */
export function salesDailySeries(labels: { revenue: string; invoices: string; average: string }): {
  series: DailyBarSeries[]
  metrics: DailyTooltipMetric[]
} {
  return {
    series: [
      { key: REVENUE_KEY, label: labels.revenue, color: chartBarColor('sales'), type: 'currency' },
    ],
    metrics: [
      { key: INVOICES_KEY, label: labels.invoices, type: 'count' },
      { key: AVERAGE_INVOICE_KEY, label: labels.average, type: 'currency' },
    ],
  }
}

/**
 * Backend day rows → chart days.
 *
 * Two labels per day on purpose: the axis gets the abbreviated form and the
 * tooltip/export the full one, both through the CENTRAL date formatter, so a
 * period crossing a year boundary is never ambiguous and a raw `YYYY-MM-DD` is
 * never shown. The rows are already ascending; sorting defensively costs nothing
 * and guarantees a chronological axis whatever the backend returns.
 *
 * The average invoice value is the day's own revenue over the day's own count,
 * rounded to a piastre — the same division the Sales KPI band already performs
 * for the whole period. A day with no invoices has no average, so the key is
 * left off the day entirely and the tooltip prints no average row for it rather
 * than printing a `0.00` that was never measured.
 */
export function toSalesDailyData(rows: readonly SalesDayRow[]): DailyBarDatum[] {
  return [...rows]
    .sort((left, right) => left.day_date.localeCompare(right.day_date))
    .map((row) => ({
      label: formatDate(row.day_date),
      fullLabel: formatDate(row.day_date),
      [REVENUE_KEY]: row.total_sales,
      [INVOICES_KEY]: row.invoices_count,
      ...(row.invoices_count > 0
        ? { [AVERAGE_INVOICE_KEY]: Math.round(row.total_sales / row.invoices_count) }
        : {}),
    }))
}

export function SalesDailyChart({
  trend,
  period,
  className,
}: {
  /** The page's own `sales_overview` days — already grouped by day in SQL. */
  readonly trend: SalesDayRow[]
  /** The page's selected period, stated on the card and in the export. */
  readonly period: string
  readonly className?: string
}) {
  const { t } = useTranslation()
  const toast = useToast()

  const { series, metrics } = useMemo(
    () =>
      salesDailySeries({
        revenue: t('sales.kpi.revenue'),
        invoices: t('sales.kpi.invoices'),
        average: t('sales.kpi.average'),
      }),
    [t],
  )
  // A pure rename of the DTO, recomputed only when the days or the language
  // actually change.
  const data = useMemo(() => toSalesDailyData(trend), [trend])

  // The workbook carries the day's REVENUE and the day's INVOICE COUNT as two
  // declared columns of two declared types: a money column in pounds and an
  // integer column of whole invoices. The exporter resolves both from the same
  // declarations the tooltip does, so a count can no longer arrive in the sheet
  // divided by 100.
  const exportSeries = useMemo(
    () => [
      ...series,
      {
        key: INVOICES_KEY,
        label: t('sales.kpi.invoices'),
        color: chartBarColor('secondary'),
        type: 'count' as const,
      },
    ],
    [series, t],
  )
  const title = t('sales.trend.title')
  const description = t('sales.trend.hint')

  if (data.length === 0) {
    return (
      <Card className={className}>
        <TrendHeading />
        <p className="py-6 text-center text-body text-foreground-muted">{t('sales.trend.empty')}</p>
      </Card>
    )
  }

  // One business day has no movement: a single column would be decoration.
  if (data.length === 1) {
    const day = trend[0]
    return (
      <Card className={className}>
        <TrendHeading />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-caption text-foreground-subtle">
              {t('sales.trend.singleDay', { date: formatDate(day.day_date) })}
            </p>
            <MoneyDisplay
              amount={day.total_sales}
              variant="auto"
              className="text-2xl font-extrabold text-foreground-strong"
            />
          </div>
          <p className="text-caption text-foreground-muted">
            {t('sales.trend.invoicesOn', { count: day.invoices_count })}
          </p>
        </div>
      </Card>
    )
  }

  // The SAME exporters the reports charts use, with the same arguments shape,
  // the same Station workbook layout and the same filename convention.
  const buildExport = () => ({
    title,
    description,
    period,
    data,
    series: exportSeries,
    summary: [
      {
        label: t('reports.charts.total'),
        value: formatMinorMoney(data.reduce((sum, datum) => sum + dayTotal(datum, series), 0)),
      },
    ],
    categoryHeader: t('sales.trend.dayColumn'),
    filename: 'station-sales-daily',
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
      id={SALES_DAILY_CHART_ID}
      className={className}
      title={title}
      description={description}
      period={period}
      data={data}
      series={series}
      // The invoice count and the average ticket are real readings of the day
      // that must not be BARS: a count of 2 beside a revenue of 24,000 would be
      // an invisible bar, and "many small tickets" against "one big ticket" is a
      // real distinction the manager reads this chart for. The chart states both
      // in the tooltip, each in its own type.
      metrics={metrics}
      dateLabel={t('sales.trend.dateLabel')}
      // The chart reads the peak day out of the very data the bars are drawn
      // from, so the two can never disagree; the page supplies only the Arabic
      // words, and the chart states them in a strong hand.
      peakLabel={t('sales.trend.peakLabel')}
      // Revenue and an invoice count do NOT compose one figure, so the tooltip
      // states no total: adding money to a count would be a meaningless number.
      totalLabel={t('reports.charts.tooltipTotal')}
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
        <h2 className="text-section text-foreground-strong">{t('sales.trend.title')}</h2>
        <p className="mt-0.5 text-caption text-foreground-subtle">{t('sales.trend.hint')}</p>
      </div>
    </div>
  )
}
