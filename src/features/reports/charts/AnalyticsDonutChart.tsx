import { useTranslation } from 'react-i18next'
import { LabelList, Pie, PieChart, type LabelProps } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui'
import { ChartShell, type ChartPresentation } from '@/components/charts/ChartShell'
import { useToast } from '@/components/ui/toast'
import { formatMinorMoney } from '@/lib/money'
import { formatDate } from '@/lib/date'
import { useFormattingPreferences } from '@/lib/formatting'
import { cn } from '@/lib/utils'
import { CATEGORY_LABEL_PREFIX, type AnalyticsChart } from './analyticsCharts'
import { exportAnalyticsExcel, exportAnalyticsPng } from './exports'

export function AnalyticsDonutChart({
  chart,
  from,
  to,
  presentation = 'card',
}: {
  chart: AnalyticsChart
  /** Business-date range; rendered through the central date formatter. */
  from: string
  to: string
  presentation?: 'card' | 'fullscreen'
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const Icon = chart.icon
  // Titles and category labels travel as translation keys, so the copy stays in
  // the catalogue and the view model carries no display strings.
  const title = t(`reports.charts.${chart.titleKey}`)
  const description = t(`reports.charts.${chart.descriptionKey}`)
  const categoryLabel = (key: string) => t(`${CATEGORY_LABEL_PREFIX}${key}`)
  // The period label is a presentation value: subscribe so Dev Settings changes
  // re-render it, and format each bound with the central date formatter.
  useFormattingPreferences()
  const period = `${formatDate(from)} — ${formatDate(to)}`
  const total = chart.total || 1
  const segments = chart.categories.map((category) => ({
    ...category,
    label: categoryLabel(category.labelKey),
    fill: category.color,
    percent: (category.value / total) * 100,
  }))
  const chartConfig = {
    value: { label: title },
    ...Object.fromEntries(
      segments.map((segment) => [segment.id, { label: segment.label, color: segment.color }]),
    ),
  }

  // The exports, the toast and the focus restoration are the SHARED shell's
  // machinery; this chart only says WHAT to export.
  const downloadPng = async () => {
    try {
      await exportAnalyticsPng(chart, period)
      toast(t('reports.charts.exportedPng'), 'success')
    } catch {
      toast(t('reports.charts.exportError'), 'error')
    }
  }
  const downloadExcel = async () => {
    try {
      exportAnalyticsExcel(chart, period)
      toast(t('reports.charts.exportedExcel'), 'success')
    } catch {
      toast(t('reports.charts.exportError'), 'error')
    }
  }

  const renderSegmentLabel = (props: LabelProps) => {
    const label = String(props.value ?? '')
    const viewBox = props.viewBox
    if (!label || !viewBox || typeof viewBox !== 'object' || !('cx' in viewBox)) return null

    const { cx, cy, innerRadius, outerRadius, startAngle, endAngle } = viewBox
    const midAngle = (startAngle + endAngle) / 2
    const angle = (-midAngle * Math.PI) / 180
    const labelRadius = innerRadius + (outerRadius - innerRadius) * 0.5
    const angularSpan = Math.abs(endAngle - startAngle)
    const availableWidth =
      angularSpan >= 359
        ? labelRadius * 2 - 4
        : Math.max(0, 2 * labelRadius * Math.sin((angularSpan * Math.PI) / 360) - 4)
    const estimatedTextWidth = label.length * 6.25
    const horizontalPadding = 12
    const badgeWidth = Math.max(32, Math.ceil(estimatedTextWidth + horizontalPadding))
    const badgeHeight = 24
    const bandThickness = outerRadius - innerRadius

    if (badgeWidth > availableWidth || badgeHeight > bandThickness) return null

    const x = cx + Math.cos(angle) * labelRadius
    const y = cy + Math.sin(angle) * labelRadius
    return (
      <g>
        <rect
          x={x - badgeWidth / 2}
          y={y - badgeHeight / 2}
          width={badgeWidth}
          height={badgeHeight}
          rx={5}
          className="fill-surface stroke-border"
          strokeWidth={1}
        />
        <text
          x={x}
          y={y}
          textAnchor="middle"
          dominantBaseline="middle"
          direction="rtl"
          className="fill-foreground"
          fontSize={12.5}
          fontWeight={700}
          stroke="none"
        >
          {label}
        </text>
      </g>
    )
  }

  const body = (mode: ChartPresentation) => (
    <>
      <div
        className={cn(
          'relative mx-auto flex min-h-56 w-full flex-col items-center justify-center',
          mode === 'fullscreen' ? 'mt-4 h-[min(48dvh,27rem)] shrink-0' : 'mt-5 h-72',
        )}
        dir="ltr"
      >
        <ChartContainer
          id={chart.id}
          config={chartConfig}
          className="mx-auto aspect-square h-auto min-h-0 w-full max-w-72 flex-1 [&_.recharts-text]:fill-foreground"
        >
          <PieChart>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) =>
                    `${formatMinorMoney(Number(value))} · ${Math.round(
                      (Number(value) / total) * 100,
                    )}%`
                  }
                />
              }
            />
            <Pie
              data={segments}
              dataKey="value"
              nameKey="label"
              innerRadius="57%"
              outerRadius="88%"
              paddingAngle={segments.length > 1 ? 2 : 0}
              cornerRadius={3}
              stroke="none"
              activeShape={false}
              isAnimationActive={false}
            >
              {segments.length <= 5 ? (
                <LabelList
                  dataKey="label"
                  position="inside"
                  content={renderSegmentLabel}
                  stroke="none"
                />
              ) : null}
            </Pie>
          </PieChart>
        </ChartContainer>
        <div
          className="mt-2 flex flex-col items-center justify-center text-center"
          dir="rtl"
          aria-live="polite"
        >
          <span className="text-2xl font-extrabold tabular-nums text-foreground-strong">
            {formatMinorMoney(chart.total, { compact: true })}
          </span>
          <span className="mt-1 text-xs text-foreground-subtle">{t('reports.charts.total')}</span>
        </div>
        <span
          className="sr-only"
          role="img"
          aria-label={`${title}: ${formatMinorMoney(chart.total)}`}
        />
      </div>
      <div
        className={cn(
          'grid gap-2 border-t border-border-subtle pt-3',
          // A wrapping responsive grid, never a scroll region: one column with no
          // room, two on a small screen, three and then four as width allows, and
          // as many rows as the segments need. Every segment — with its own amount
          // and share, kept together in one cell — stays visible at once.
          mode === 'fullscreen'
            ? 'mt-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'
            : 'mt-5',
        )}
        dir="rtl"
        data-testid="donut-chart-legend"
      >
        {segments.map((segment) => (
          <div
            key={segment.id}
            className="flex items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md px-2 py-1 text-sm odd:bg-surface-muted/40"
          >
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <span
                className="size-2.5 shrink-0 self-center rounded-full"
                style={{ background: segment.color }}
              />
              <span className="min-w-0 wrap-break-word">{segment.label}</span>
            </span>
            <span className="flex items-center gap-3 tabular-nums text-foreground-muted">
              <span>{formatMinorMoney(segment.value, { compact: true })}</span>
              <strong className="min-w-10 text-end text-foreground">
                {Math.round(segment.percent)}%
              </strong>
            </span>
          </div>
        ))}
      </div>
    </>
  )

  return (
    <ChartShell
      id={chart.id}
      title={title}
      description={description}
      // The reports page has its own period picker above the grid, so the inline
      // card does not repeat the window; the fullscreen dialog has no such
      // context, so it states it there.
      period={t('reports.charts.period', { period })}
      periodVisibility="fullscreen"
      icon={<Icon size={19} aria-hidden />}
      onExportPng={downloadPng}
      onExportExcel={downloadExcel}
      presentation={presentation}
      // A donut segment's badge can reach the card's edge; the inline card must
      // not clip it, while fullscreen keeps the dialog's own bounds.
      inlineCardClassName="overflow-visible"
      testId={`chart-${chart.id}`}
    >
      {body}
    </ChartShell>
  )
}
