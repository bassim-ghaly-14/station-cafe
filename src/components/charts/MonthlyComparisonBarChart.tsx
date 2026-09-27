/**
 * MonthlyComparisonBarChart — a monthly bar chart whose series can be either
 * grouped side by side or stacked into one bar per month.
 *
 * The component is deliberately DUMB. It knows how to draw N series for each
 * month — side by side when they are COMPARABLE, or stacked into a single bar
 * when they are COMPOSING parts of one total — and nothing else: no business
 * vocabulary (no Cafe, no Wash, no revenue, no expense category), no data
 * source, no date filter, no query. A future page can point it at Cash vs Card,
 * Sales vs Expenses, this year vs last year, or spend split by category, by
 * passing different `series` and `data`, without touching this file.
 *
 * House rules it follows rather than reinvents:
 *  - recharts through the shared `ChartContainer` / `ChartTooltip` /
 *    `ChartTooltipContent` primitives, exactly like the reports donuts and the
 *    sales trend;
 *  - theme colors only — every series color arrives as a Station token, so light
 *    and dark mode remain the theme's decision;
 *  - the plot is `dir="ltr"` (recharts lays out left-to-right, like a calendar)
 *    while every label stays Arabic and RTL — the decision the sales trend
 *    already documents;
 *  - fullscreen is the EXISTING mechanism, and so is the actions menu: both now
 *    come from the SHARED `ChartShell`, the one card the reports donuts and the
 *    daily bar chart render through too, so there is no second fullscreen system
 *    and no second export affordance anywhere in the application;
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui'
import { Minus, TrendingDown, TrendingUp } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import { ChartShell, type ChartPresentation } from './ChartShell'
import {
  formatPercent,
  monthOverMonth,
  monthTotal,
  seriesTooltipName,
  seriesTooltipValue,
  seriesValue,
  type MonthlyComparisonDatum,
  type MonthOverMonth,
  type MonthlySeriesConfig,
} from './monthlyComparison'

export type { ChartPresentation }

export type MonthlyComparisonBarChartProps = {
  /** Stable id: it namespaces the fullscreen trigger and the chart element. */
  id: string
  title: string
  description?: string
  /** Period or scope line, shown under the description. */
  period?: string
  /** Ascending by `month`; the last entry is the "current" month. */
  data: readonly MonthlyComparisonDatum[]
  series: readonly MonthlySeriesConfig[]
  /**
   * How the series are drawn inside a month:
   *  - `grouped` (the default) — one bar per series, side by side, for series
   *    that are COMPARED against each other;
   *  - `stacked` — one bar per month, every series a coloured segment of it, for
   *    series that COMPOSE a single total.
   *
   * The default keeps every existing caller byte-for-byte the same chart, so a
   * page that compares two lines can never be silently turned into a stack.
   */
  layout?: 'grouped' | 'stacked'
  /** Stack identity, namespaced per chart so two charts on a page stay apart. */
  stackId?: string
  /** Formats a series value in the tooltip and the legend. */
  formatValue?: (value: number) => string
  /** Suffix for the month-over-month reading, already localized. */
  comparisonLabel?: string
  /** Shown when the reading cannot be computed, already localized. */
  comparisonUnavailableLabel?: string
  /**
   * Whether the tooltip states the MONTH'S TOTAL under its rows.
   *
   * It is on by default for a stack, where the bar IS the total and the row is
   * only ever part of it. A grouped chart compares two lines side by side, and
   * for some pairs (Cash vs Card) their sum means nothing — so a grouped caller
   * has to say explicitly that its series really do compose one total. Cafe and
   * Wash are exactly that, and the sales chart turns this on.
   *
   * The figure is read from the HOVERED row through the same `monthTotal` the
   * month-over-month reading already uses, so the tooltip can never disagree
   * with the indicator, and no data source or calculation is involved.
   */
  showTotal?: boolean
  /** Export callbacks; when both are absent the actions menu is not rendered. */
  onExportPng?: () => void | Promise<void>
  onExportExcel?: () => void | Promise<void>
  presentation?: ChartPresentation
  className?: string
}

export function MonthlyComparisonBarChart({
  id,
  title,
  description,
  period,
  data,
  series,
  layout = 'grouped',
  stackId,
  formatValue,
  comparisonLabel,
  comparisonUnavailableLabel,
  showTotal,
  onExportPng,
  onExportExcel,
  presentation = 'card',
  className,
}: MonthlyComparisonBarChartProps) {
  const { t } = useTranslation()
  const stacked = layout === 'stacked'
  // A stack is identified by name, and the name is namespaced by the chart id so
  // two stacked charts rendered on the same page can never share a stack.
  const stack = stackId ?? `stack-${id}`

  // The reading is a pure function of the data: it is recomputed only when the
  // data or the series change, never on an unrelated re-render.
  const change = useMemo(() => monthOverMonth(data, series), [data, series])
  const format = formatValue ?? String
  const chartConfig = useMemo(
    () =>
      Object.fromEntries(
        series.map((item) => [item.key, { label: item.label, color: item.color }]),
      ),
    [series],
  )
  const latest = data.at(-1) ?? null
  // A stack always states its total; a group states it only when its caller says
  // the series compose one. The default therefore follows the layout.
  const totalVisible = showTotal ?? stacked

  // The tooltip FOOTER: the period total for the hovered row, read from that
  // row's own datum — never recomputed outside the chart, never a static value.
  // Declared here so the tooltip primitive receives a stable render function.
  const renderTooltipFooter = (items: { payload?: unknown }[]) => {
    const datum = items?.[0]?.payload as MonthlyComparisonDatum | undefined
    if (!datum) return null
    return (
      <>
        <span className="text-foreground-muted">{t('reports.charts.tooltipTotal')}</span>
        <span className="tabular-nums">{format(monthTotal(datum, series))}</span>
      </>
    )
  }

  // The card, its header, the fullscreen dialog and the export menu are the
  // SHARED `ChartShell` — the same one the reports donuts and the daily bar
  // chart use. Only the plot and the legend below are this chart's own.
  const body = (mode: ChartPresentation) => (
    <>
      {/* The plot reads left-to-right like the calendar; its labels do not. */}
      <div
        dir="ltr"
        className={cn(
          'relative w-full min-h-0',
          // A definite height in fullscreen, and no `flex-1` competing with it: a
          // flex-basis of 0 would let the plot collapse and hand its space to the
          // category grid, and the chart would resize itself out of view. `shrink-0`
          // then keeps that height whatever the grid below does — many categories
          // add rows to the CARD, never take height from the plot.
          mode === 'fullscreen' ? 'mt-4 h-[min(48dvh,27rem)] shrink-0' : 'mt-5 h-72',
        )}
        data-testid="monthly-chart-plot"
      >
        <ChartContainer id={id} config={chartConfig} className="[&_.recharts-text]:fill-foreground">
          <BarChart
            data={data as MonthlyComparisonDatum[]}
            margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
          >
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={4}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(value: number) => format(value)}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  // A stack names every configured series for the hovered month,
                  // and a category unused that month is a real `0`. It is not a
                  // drawn segment, so it is not a row either. A grouped chart
                  // draws its zeros and keeps them.
                  {...(stacked ? { hideZeroValues: true } : {})}
                  // The HEADING is the PERIOD: `label` carries the abbreviated
                  // axis month, so the full "سبتمبر 2026" is read from the mark's
                  // own datum. It states WHEN, and is not the row's name.
                  labelFormatter={(_label, items) => {
                    const datum = items?.[0]?.payload as MonthlyComparisonDatum | undefined
                    return datum?.fullLabel ?? datum?.label ?? ''
                  }}
                  // Each ROW is about ONE entity — a sales section, an expense
                  // category — and is named by the CHART'S OWN Arabic label
                  // for that series, never by the mark's key and never by the
                  // month's axis label. The month is already the heading
                  // above, so it states the period and nothing else.
                  itemLabel={(_item, key) => seriesTooltipName(series, key)}
                  // The name is what the manager is looking for in a row of
                  // figures, so it carries the project's bold weight.
                  boldItemLabel
                  // The VALUE alone: the row already prints the name, and
                  // repeating it here is what produced "MAINTENANCE صيانة".
                  formatter={(value, _name, item) =>
                    seriesTooltipValue(
                      series,
                      String(item.dataKey ?? item.name ?? _name),
                      Number(value),
                      format,
                    )
                  }
                  // The total of every series of the hovered month. In a stack the bar
                  // IS that total, so the line is always there; in a group it
                  // appears when the caller says its series compose one. Either way
                  // the figure is read from the hovered row — never recomputed
                  // outside the chart, and never a static value.
                  {...(totalVisible ? { footer: renderTooltipFooter } : {})}
                />
              }
            />
            {series.map((item, index) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                name={item.key}
                fill={item.color}
                // In a stack every series shares ONE bar per month, so only the
                // TOP segment carries the rounded cap; rounding every segment
                // would draw a seam down the middle of the bar.
                radius={!stacked || index === series.length - 1 ? [3, 3, 0, 0] : 0}
                // Grouped bars share the month's width between them, so they
                // stay slim; a single stacked bar per month is the whole month,
                // and may be wider — while still bounded so many months fit.
                maxBarSize={stacked ? 56 : 26}
                // The same id on every series is what makes recharts add the
                // segments up into one column instead of placing them side by
                // side. Its ABSENCE is what produces the grouped chart.
                {...(stacked ? { stackId: stack } : {})}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ChartContainer>
        <span
          className="sr-only"
          role="img"
          aria-label={[
            title,
            period,
            latest
              ? `${latest.fullLabel ?? latest.label}: ${format(monthTotal(latest, series))}`
              : '',
          ]
            .filter(Boolean)
            .join(' — ')}
        />
      </div>

      {/* The legend doubles as the per-series value of the latest month, so a
            bar's colour is never the only thing identifying the series. */}
      <div
        className={cn(
          'grid gap-2 border-t border-border-subtle pt-3',
          // The category area NEVER scrolls and never clips. In fullscreen it is a
          // plain responsive GRID: one column when there is no room, widening to
          // four on a full desktop, and it WRAPS into as many rows as the
          // categories need. The card above grows to fit those rows, so every
          // category is on screen at the same time — which is the whole point of
          // listing them, and the reason a scroll region was the wrong answer.
          mode === 'fullscreen'
            ? 'mt-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'
            : 'mt-3',
        )}
        dir="rtl"
        data-testid="monthly-chart-legend"
      >
        {series.map((item) => {
          const value = latest ? seriesValue(latest, item.key) : 0
          return (
            <div
              key={item.key}
              // A grid cell, not a flex row: the name keeps the room it needs and
              // WRAPS within its own cell rather than being cut off, while the
              // value stays pinned to the same cell so the reader can never lose
              // track of which figure belongs to which category.
              className="flex items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md px-2 py-1 text-sm odd:bg-surface-muted/40"
            >
              <span className="flex min-w-0 items-center gap-2 font-medium">
                <span
                  className="size-2.5 shrink-0 self-center rounded-full"
                  style={{ background: item.color }}
                />
                <span className="min-w-0 wrap-break-word">{item.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-foreground-muted">
                {item.format ? item.format(value) : format(value)}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )

  return (
    <ChartShell
      id={id}
      title={title}
      description={description}
      period={period}
      // The month-over-month reading is this chart's own toolbar content; the
      // shell renders it beside the fullscreen and export buttons.
      toolbarExtra={
        <MonthOverMonthBadge
          change={change}
          label={comparisonLabel}
          unavailableLabel={comparisonUnavailableLabel}
        />
      }
      onExportPng={onExportPng}
      onExportExcel={onExportExcel}
      presentation={presentation}
      className={className}
      testId={`monthly-chart-${id}`}
    >
      {body}
    </ChartShell>
  )
}

/**
 * The month-over-month reading.
 *
 * The ICON carries the direction, so the meaning survives without colour and
 * without depending on a `+` sign being read inside an RTL line. When there is
 * nothing to compare (a single month, or a previous month of zero) the badge
 * says so — it never prints `NaN%` or `Infinity%`.
 */
function MonthOverMonthBadge({
  change,
  label,
  unavailableLabel,
}: {
  readonly change: MonthOverMonth
  readonly label?: string
  readonly unavailableLabel?: string
}) {
  if (change.trend === 'unavailable') {
    return <span className="text-caption text-foreground-subtle">{unavailableLabel ?? '—'}</span>
  }
  const Icon = change.trend === 'up' ? TrendingUp : change.trend === 'down' ? TrendingDown : Minus
  const tone =
    change.trend === 'up'
      ? 'text-success'
      : change.trend === 'down'
        ? 'text-destructive'
        : 'text-foreground-muted'
  return (
    <span className={cn('flex items-center gap-1 text-caption font-medium', tone)}>
      <Icon size={15} aria-hidden />
      <span className="tabular-nums">{formatPercent(change.percent ?? 0)}%</span>
      {label ? <span className="text-foreground-subtle">{label}</span> : null}
    </span>
  )
}
