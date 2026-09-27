/**
 * PNG / Excel export for a Station BAR chart, at any granularity.
 *
 * These are ADDITIONS to the existing export system, not a second one:
 *  - the PNG is drawn with the same canvas recipe the reports donuts use (Station
 *    tokens read from the live theme, `Cairo` type, RTL text, the same download
 *    helper), because the alternative — screenshotting the DOM — would capture a
 *    tooltip and the current scroll state instead of the report;
 *  - the Excel workbook is built by the SAME `createStationReportSheet` /
 *    `downloadStationWorkbook` helpers the donut export uses, so a workbook has
 *    the identical Station layout, brand header and totals row.
 *
 * WHY IT IS NOT "the monthly exporter"
 * ------------------------------------
 * It began as the monthly comparison exporter and is now the shared exporter for
 * the monthly charts AND the daily bar chart. Nothing in it was ever month
 * specific: it walks a list of categories, draws one bar group per category, and
 * writes one workbook row per category. The granularity is the CALLER's — a month
 * key or a day key — so the Sales and Expenses daily charts export through this
 * exact file, with the same Station layout, the same naming convention and the
 * same toast, rather than growing a near-identical second exporter beside it.
 *
 * The module knows nothing about what the series MEAN. Callers pass already
 * localized titles, series labels and category labels, so a page exporting Cash
 * vs Card, or spend per day, reuses this file unchanged.
 */
import { formatMinorMoney } from '@/lib/money'
import { downloadBlob, resolveThemeColor } from '@/features/reports/charts/exports'
import {
  createStationReportSheet,
  downloadStationWorkbook,
  type ReportColumn,
} from '@/features/reports/charts/excelReport'
import i18n from '@/lib/i18n'
import { chartValueColumnFormat, isMoneyValue, type ChartValueType } from './chartValue'
import type { DailyBarDatum, DailyBarSeries } from './dailyBar'
import type { MonthlyComparisonDatum, MonthlySeriesConfig } from './monthlyComparison'

/**
 * One plotted category: a month for the monthly charts, a day for the daily one.
 *
 * It is the shared shape both models already satisfy — a display label, an
 * optional fuller label, and the series values under their keys — so neither
 * model is imported for its sake and neither is redefined here.
 */
export type BarChartCategory = (MonthlyComparisonDatum | DailyBarDatum) & {
  label: string
  fullLabel?: string
}

/** The series shape both models already satisfy. */
export type BarChartSeries = MonthlySeriesConfig | DailyBarSeries

/**
 * The semantic type of an exported series, when it declares one.
 *
 * A series that declares no type is read as MONEY, which is the whole history of
 * these series: the reports monthly comparisons are money on both sides of
 * every comparison, and that is what they were written to mean. It is the
 * DAILY charts that broke the assumption — they carry a COUNT beside an amount
 * — so they are the ones that declare a type, and declaring one is what turns
 * the shared exporter from "every column is pounds" into "each column is what
 * it is".
 */
function seriesType(series: BarChartSeries): ChartValueType | undefined {
  return (series as { type?: ChartValueType }).type
}

/** The workbook columns a series of this type is written into, unconverted. */
function columnValue(series: BarChartSeries, value: number, toMajor: (v: number) => number) {
  // A count is a count of things: dividing it by 100 is what turned 42 invoices
  // into `0.42` in the workbook, and no unit conversion may touch it.
  return isMoneyValue(seriesType(series)) ? toMajor(value) : value
}

/** Everything the exporters need, already resolved for display. */
export type BarChartExport = {
  title: string
  description: string
  /** Period line, already formatted for the reader. */
  period: string
  /** Ascending by category: by `month`, or by day. */
  data: readonly BarChartCategory[]
  series: readonly BarChartSeries[]
  /** Converts a stored (minor-unit) amount into workbook major units. */
  toMajor?: (value: number) => number
  /** Extra summary rows: label already localized, value already formatted. */
  summary?: { label: string; value: string | number }[]
  /** Header of the category column, already localized. */
  categoryHeader: string
  filename: string
  sheetName?: string
  /**
   * Mirrors the chart's own layout so the PNG shows what the screen shows:
   *  - `grouped` (the default) — one bar per series, side by side, for series
   *    that are compared;
   *  - `stacked` — ONE bar per category, each series a coloured segment of it,
   *    for series that compose a single total.
   *
   * The workbook is identical either way: one row per category, one column per
   * series and a category total, which already states a stack as plainly as it
   * states a group.
   */
  layout?: 'grouped' | 'stacked'
}

function seriesNumber(row: BarChartCategory, key: string): number {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const WIDTH = 1200
const HEIGHT = 900
const PLOT = { left: 90, right: 1130, top: 250, bottom: 720 }

/**
 * Draw the bars: one GROUP of side-by-side bars per month when the series are
 * compared, or ONE stacked column per month when they compose a single total.
 *
 * Every visible string comes from the caller (already localized), and every color
 * from the Station tokens, so the image says exactly what the screen says in
 * either theme.
 */
export async function exportBarChartPng(report: BarChartExport) {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable')
  const css = getComputedStyle(document.documentElement)
  const background = css.getPropertyValue('--surface').trim()
  const strongText = css.getPropertyValue('--foreground-strong').trim()
  const subtleText = css.getPropertyValue('--foreground-subtle').trim()
  const gridColor = css.getPropertyValue('--chart-grid').trim()
  const frameColor = css.getPropertyValue('--chart-frame').trim()

  context.fillStyle = background
  context.fillRect(0, 0, WIDTH, HEIGHT)
  context.direction = 'rtl'
  context.textAlign = 'right'
  context.fillStyle = strongText
  context.font = '700 40px Cairo, sans-serif'
  context.fillText(report.title, WIDTH - 60, 80)
  context.fillStyle = subtleText
  context.font = '24px Cairo, sans-serif'
  context.fillText(report.description, WIDTH - 60, 124)
  context.fillText(i18n.t('reports.charts.period', { period: report.period }), WIDTH - 60, 166)

  const rows = report.data
  const stacked = report.layout === 'stacked'
  const rowTotal = (row: BarChartCategory) =>
    report.series.reduce((sum, item) => sum + seriesNumber(row, item.key), 0)
  // A grouped chart scales against the tallest SINGLE bar, a stack against the
  // tallest MONTH — the bar is the total, so the axis has to be the total too.
  const max = Math.max(
    1,
    ...(stacked
      ? rows.map(rowTotal)
      : rows.flatMap((row) => report.series.map((item) => seriesNumber(row, item.key)))),
  )
  const colors = report.series.map((item) => resolveThemeColor(item.color))
  const groupWidth = rows.length > 0 ? (PLOT.right - PLOT.left) / rows.length : 0
  // A stack is one bar standing for the month, so it may be wider than a single
  // bar of a group — and it is still capped, so twelve months never collide.
  const barWidth = Math.max(
    6,
    stacked
      ? Math.min(56, groupWidth * 0.55)
      : Math.min(48, (groupWidth * 0.7) / Math.max(1, report.series.length)),
  )

  context.strokeStyle = gridColor
  context.lineWidth = 1
  for (let step = 0; step <= 4; step += 1) {
    const y = PLOT.bottom - ((PLOT.bottom - PLOT.top) * step) / 4
    context.beginPath()
    context.moveTo(PLOT.left, y)
    context.lineTo(PLOT.right, y)
    context.stroke()
  }

  const scale = (value: number) => ((PLOT.bottom - PLOT.top) * value) / max

  rows.forEach((row, rowIndex) => {
    const center = PLOT.left + groupWidth * (rowIndex + 0.5)
    if (stacked) {
      // ONE column per month: each segment is painted on top of the running
      // total, so the column's height IS the month's total and its colours are
      // the composition of it.
      let base = PLOT.bottom
      report.series.forEach((item, seriesIndex) => {
        const value = seriesNumber(row, item.key)
        if (value <= 0) return
        const height = scale(value)
        context.fillStyle = colors[seriesIndex] ?? colors[0]
        context.fillRect(center - barWidth / 2, base - height, barWidth, height)
        base -= height
      })
    } else {
      const span = barWidth * report.series.length
      report.series.forEach((item, seriesIndex) => {
        const value = seriesNumber(row, item.key)
        const height = scale(value)
        const x = center + span / 2 - barWidth * (seriesIndex + 1)
        context.fillStyle = colors[seriesIndex] ?? colors[0]
        context.fillRect(x, PLOT.bottom - height, barWidth - 2, height)
      })
    }
    context.fillStyle = subtleText
    context.font = '20px Cairo, sans-serif'
    context.textAlign = 'center'
    context.fillText(String(row.fullLabel ?? row.label), center, PLOT.bottom + 32)
  })

  context.strokeStyle = frameColor
  context.beginPath()
  context.moveTo(PLOT.left, PLOT.top - 10)
  context.lineTo(PLOT.left, PLOT.bottom)
  context.lineTo(PLOT.right, PLOT.bottom)
  context.stroke()

  context.textAlign = 'right'
  report.series.forEach((item, index) => {
    const y = PLOT.bottom + 90 + index * 44
    context.fillStyle = colors[index] ?? colors[0]
    context.fillRect(PLOT.right - 18, y - 16, 18, 18)
    context.fillStyle = strongText
    context.font = '24px Cairo, sans-serif'
    const total = rows.reduce((sum, row) => sum + seriesNumber(row, item.key), 0)
    context.fillText(
      `${item.label} — ${formatMinorMoney(total, { compact: true })}`,
      PLOT.right - 32,
      y,
    )
  })

  await new Promise<void>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? (downloadBlob(blob, `${report.filename}.png`), resolve())
          : reject(new Error('PNG export failed')),
      'image/png',
    ),
  )
}

/**
 * The same series as a Station workbook: one row per month, one column per
 * series plus the month total, with the shared brand header and a SUM totals row.
 */
export function exportBarChartExcel(report: BarChartExport) {
  const toMajor = report.toMajor ?? ((value: number) => value / 100)
  // The columns are declared, not assumed: a money series is written in pounds
  // with the money format, a counted series as a whole number of things, a
  // percentage as a percentage. The category TOTAL sums the money series only —
  // adding 42 invoices to 24,000 piastres is not a figure of anything.
  const totalSeries = report.series.filter((item) => isMoneyValue(seriesType(item)))
  const columns: ReportColumn[] = [
    { header: report.categoryHeader, align: 'right', format: 'text' },
    ...report.series.map((item) => ({
      header: item.label,
      align: 'right' as const,
      format: seriesType(item) ? chartValueColumnFormat(seriesType(item)) : ('currency' as const),
    })),
    { header: i18n.t('reports.charts.total'), align: 'right', format: 'currency' },
  ]
  const rows = report.data.map((row) => [
    String(row.fullLabel ?? row.label),
    ...report.series.map((item) => columnValue(item, seriesNumber(row, item.key), toMajor)),
    toMajor(totalSeries.reduce((sum, item) => sum + seriesNumber(row, item.key), 0)),
  ])
  const labels = {
    period: i18n.t('reports.charts.period', { period: '' }).trim(),
    generated: i18n.t('reports.charts.generated'),
    summary: i18n.t('reports.charts.summary'),
    details: i18n.t('reports.charts.details'),
    total: i18n.t('reports.charts.total'),
  }
  const { book } = createStationReportSheet({
    title: report.title,
    description: report.description,
    period: report.period,
    columns,
    rows,
    summary: report.summary ?? [],
    total: [
      i18n.t('reports.charts.total'),
      ...report.series.map((item) =>
        columnValue(
          item,
          report.data.reduce((sum, row) => sum + seriesNumber(row, item.key), 0),
          toMajor,
        ),
      ),
      1,
    ],
    sheetName: report.sheetName ?? 'التقرير',
    labels,
  })
  downloadStationWorkbook(book, `${report.filename}.xlsx`)
}
