import { CURRENCY_LABEL, formatMinorMoney } from '@/lib/money'
import { createStationReportSheet, downloadStationWorkbook, type ReportColumn } from './excelReport'
import i18n from '@/lib/i18n'
import { CATEGORY_LABEL_PREFIX, type AnalyticsChart } from './analyticsCharts'

/**
 * Resolve a `var(--token)` series color against the LIVE theme.
 *
 * Shared with the monthly comparison exporter: a canvas cannot read a CSS
 * variable, so every chart color has to be read out of the theme at export time
 * or it would silently be drawn as an invalid value.
 */
export function resolveThemeColor(color: string): string {
  const token = color.match(/^var\((--[^)]+)\)$/)?.[1]
  if (!token) return color
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || color
}

/**
 * The one way a report file leaves the app.
 *
 * Shared by every exporter (the analytics PNG, the analytics workbook, and the
 * monthly comparison chart) so there is a single object-URL lifecycle and a
 * single revocation, instead of a copy per chart.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * Resolved here rather than in the chart model: the exporters run outside React
 * (canvas + xlsx), so they read the same catalogue through the i18n singleton.
 * Titles and category labels therefore print identically to the screen.
 */
function chartTitle(chart: AnalyticsChart) {
  return i18n.t(`reports.charts.${chart.titleKey}`)
}

function chartDescription(chart: AnalyticsChart) {
  return i18n.t(`reports.charts.${chart.descriptionKey}`)
}

function categoryLabel(key: string) {
  return i18n.t(`${CATEGORY_LABEL_PREFIX}${key}`)
}

export async function exportAnalyticsPng(chart: AnalyticsChart, period: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 900
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable')
  const css = getComputedStyle(document.documentElement)
  const background = css.getPropertyValue('--surface').trim()
  const strongText = css.getPropertyValue('--foreground-strong').trim()
  const subtleText = css.getPropertyValue('--foreground-subtle').trim()
  const totalTextColor = '#FFFFFF'
  context.fillStyle = background
  context.fillRect(0, 0, 1200, 900)
  context.direction = 'rtl'
  context.textAlign = 'right'
  context.fillStyle = strongText
  context.font = '700 42px Cairo, sans-serif'
  context.fillText(chartTitle(chart), 1120, 90)
  context.fillStyle = subtleText
  context.font = '24px Cairo, sans-serif'
  context.fillText(chartDescription(chart), 1120, 135)
  context.fillText(`الفترة: ${period}`, 1120, 180)
  const segmentColors = chart.categories.map((category) => resolveThemeColor(category.color))
  const total = chart.total || 1
  let start = -Math.PI / 2
  const cx = 600
  const cy = 470
  const radius = 210
  chart.categories.forEach((category, index) => {
    context.fillStyle = segmentColors[index] ?? css.getPropertyValue('--primary')
    const end = start + (category.value / total) * Math.PI * 2
    context.beginPath()
    context.moveTo(cx, cy)
    context.arc(cx, cy, radius, start, end)
    context.closePath()
    context.fill()
    start = end
  })
  context.globalCompositeOperation = 'destination-out'
  context.beginPath()
  context.arc(cx, cy, 112, 0, Math.PI * 2)
  context.fill()
  context.globalCompositeOperation = 'source-over'
  context.textAlign = 'center'
  context.fillStyle = totalTextColor
  context.font = '800 34px Cairo, sans-serif'
  context.fillText(formatMinorMoney(chart.total, { compact: true }), cx, cy + 8)
  context.fillStyle = totalTextColor
  context.font = '20px Cairo, sans-serif'
  context.fillText('إجمالي', cx, cy + 42)
  context.textAlign = 'right'
  chart.categories.forEach((category, index) => {
    const y = 760 + index * 42
    context.fillStyle = segmentColors[index] ?? css.getPropertyValue('--primary')
    context.fillRect(1100, y - 16, 18, 18)
    context.fillStyle = strongText
    context.font = '22px Cairo, sans-serif'
    context.fillText(
      `${categoryLabel(category.labelKey)} — ${formatMinorMoney(category.value, { compact: true })} (${Math.round((category.value / total) * 100)}%)`,
      1080,
      y,
    )
  })
  await new Promise<void>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? (downloadBlob(blob, `${chart.exportFilename}.png`), resolve())
          : reject(new Error('PNG export failed')),
      'image/png',
    ),
  )
}

export function exportAnalyticsExcel(chart: AnalyticsChart, period: string) {
  const columns: ReportColumn[] = [
    { header: 'الفئة', align: 'right', format: 'text' },
    { header: `القيمة (${CURRENCY_LABEL})`, align: 'right', format: 'currency' },
    { header: 'النسبة', align: 'right', format: 'percent' },
  ]
  const rows = chart.categories.map((category) => [
    categoryLabel(category.labelKey),
    category.value / 100,
    category.value / chart.total,
  ])
  const labels = {
    period: i18n.t('reports.charts.period', { period: '' }).trim(),
    generated: i18n.t('reports.charts.generated'),
    summary: i18n.t('reports.charts.summary'),
    details: i18n.t('reports.charts.details'),
    total: i18n.t('reports.charts.total'),
  }
  const { book } = createStationReportSheet({
    title: chartTitle(chart),
    description: chartDescription(chart),
    period,
    columns,
    rows,
    summary: [
      { label: 'إجمالي القيمة', value: chart.total / 100, format: 'currency' },
      { label: 'عدد الفئات', value: chart.categories.length, format: 'integer' },
    ],
    total: [labels.total, chart.total / 100, 1],
    sheetName: 'التقرير',
    labels,
  })
  downloadStationWorkbook(book, `${chart.exportFilename}.xlsx`)
}
