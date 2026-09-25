import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LabelList, Pie, PieChart, type LabelProps } from 'recharts'
import {
  Button,
  Card,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Dialog,
} from '@/components/ui'
import { FileDown, Maximize2, MoreHorizontal } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { formatMinorMoney } from '@/lib/money'
import { formatDate } from '@/lib/date'
import { useFormattingPreferences } from '@/lib/formatting'
import { cn } from '@/lib/utils'
import type { AnalyticsChart } from './analyticsCharts'
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
  const [open, setOpen] = useState(false)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const fullscreen = presentation === 'fullscreen'
  // The period label is a presentation value: subscribe so Dev Settings changes
  // re-render it, and format each bound with the central date formatter.
  useFormattingPreferences()
  const period = `${formatDate(from)} — ${formatDate(to)}`
  const total = chart.total || 1
  const segments = chart.categories.map((category) => ({
    ...category,
    fill: category.color,
    percent: (category.value / total) * 100,
  }))
  const chartConfig = {
    value: { label: chart.title },
    ...Object.fromEntries(
      segments.map((segment) => [segment.id, { label: segment.label, color: segment.color }]),
    ),
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

  const closeFullscreen = () => {
    setFullscreenOpen(false)
    requestAnimationFrame(() => document.getElementById(`fullscreen-trigger-${chart.id}`)?.focus())
  }

  const downloadPng = async () => {
    setOpen(false)
    try {
      await exportAnalyticsPng(chart, period)
      toast(t('reports.charts.exportedPng'), 'success')
    } catch {
      toast(t('reports.charts.exportError'), 'error')
    }
  }
  const downloadExcel = async () => {
    setOpen(false)
    try {
      await exportAnalyticsExcel(chart, period)
      toast(t('reports.charts.exportedExcel'), 'success')
    } catch {
      toast(t('reports.charts.exportError'), 'error')
    }
  }

  return (
    <>
      <Card
        className={cn(
          'relative flex flex-col p-5 shadow-none',
          fullscreen
            ? 'h-[min(68dvh,38rem)] min-h-120 overflow-visible'
            : 'min-h-88 overflow-visible',
        )}
        data-testid={`${fullscreen ? 'fullscreen-' : ''}chart-${chart.id}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center bg-accent text-primary">
              <Icon size={19} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-section text-start">{chart.title}</h2>
              <p className="mt-0.5 text-caption">{chart.description}</p>
              {fullscreen ? (
                <p className="mt-1 text-sm text-foreground-muted">
                  {t('reports.charts.period', { period })}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!fullscreen ? (
              <Button
                id={`fullscreen-trigger-${chart.id}`}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${t('reports.charts.fullscreen')}: ${chart.title}`}
                title={t('reports.charts.fullscreen')}
                onClick={() => setFullscreenOpen(true)}
              >
                <Maximize2 size={17} aria-hidden />
              </Button>
            ) : null}
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('reports.charts.actions')}
                title={t('reports.charts.actions')}
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
              >
                <MoreHorizontal size={18} aria-hidden />
              </Button>
              {open ? (
                <div
                  role="menu"
                  className="absolute inset-e-0 top-11 z-10 w-44 rounded-md border border-border-strong bg-surface-popover p-1 shadow-lg"
                >
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => void downloadPng()}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-start text-sm hover:bg-surface-hover"
                  >
                    <FileDown size={16} aria-hidden />
                    {t('reports.charts.png')}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => void downloadExcel()}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-start text-sm hover:bg-surface-hover"
                  >
                    <FileDown size={16} aria-hidden />
                    {t('reports.charts.excel')}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div
          className={cn(
            'relative mx-auto flex min-h-56 w-full flex-col items-center justify-center',
            fullscreen ? 'mt-4 h-[min(48dvh,27rem)] flex-1' : 'mt-5 h-72',
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
            aria-label={`${chart.title}: ${formatMinorMoney(chart.total)}`}
          />
        </div>
        <div
          className={cn(
            'grid gap-2 border-t border-border-subtle pt-3',
            fullscreen ? 'mt-4 sm:grid-cols-2 sm:gap-x-8' : 'mt-5',
          )}
          dir="rtl"
        >
          {segments.map((segment) => (
            <div key={segment.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <span className="size-2.5 rounded-full" style={{ background: segment.color }} />
                {segment.label}
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
      </Card>
      {!fullscreen ? (
        <Dialog
          open={fullscreenOpen}
          onClose={closeFullscreen}
          title={t('reports.charts.fullscreen')}
          className="w-[calc(100vw-1rem)] max-w-none max-h-[calc(100dvh-1rem)] p-3 sm:p-5"
        >
          <AnalyticsDonutChart chart={chart} from={from} to={to} presentation="fullscreen" />
        </Dialog>
      ) : null}
    </>
  )
}
