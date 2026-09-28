/**
 * DailyBarChart — the ONE daily bar chart of the application.
 *
 * It replaces what used to be two separate daily plots (the Sales revenue trend
 * and the Expenses spend trend) with a single configurable component. There is
 * deliberately no `SalesDailyChart` and no `ExpensesDailyChart`: both pages point
 * THIS component at a different dataset, the way a future page would point it at
 * Cash vs Card or a POS hour-by-hour.
 *
 * What it owns (so no page has to repeat it):
 *  - the `ChartShell` card, and with it the fullscreen dialog and the export
 *    actions menu — the SAME ones the reports charts use, not a second pair;
 *  - the plot frame, the grid, both axes, the tooltip wiring and the bar labels;
 *  - the `dir="ltr"` plot with RTL labels and an RTL tooltip — recharts lays out
 *    left-to-right, like a calendar, while the prose stays right-to-left;
 *  - the centralized Station colour roles, so light and dark mode are the theme's
 *    decision and Dev Settings repaints every bar through the same variables;
 *  - a fixed, non-animated mark (`isAnimationActive={false}`) — a POS screen must
 *    not animate on every period change.
 *
 * What it deliberately does NOT own: the data source, the date filter, the
 * aggregation, the empty and single-day states, the peak reading and every word
 * on screen. Those are the page's business, and keeping them out of here is what
 * stops this from being a Sales chart with a different name.
 *
 * GRANULARITY IS DAILY AND CANNOT BE MISREAD
 * -------------------------------------------
 * The category axis is the calendar day of the period, and `data` is one entry
 * per day as the backend grouped it. There is no month bucketing anywhere in
 * this file, and no aggregation of any kind: the component draws what it is
 * handed.
 *
 * THE BARS ARE HORIZONTAL, ONE ROW PER DAY
 * ----------------------------------------
 * The plot is `layout="vertical"`, which is recharts' name for a chart whose
 * CATEGORIES run down the Y axis and whose VALUES run along the X axis: a day
 * is a row, and the bar grows horizontally out of the value axis. That is the
 * shape a person actually reads a day-by-day figure in — label, bar, figure, on
 * one line — and the only orientation in which thirty Arabic day labels and
 * thirty figures both stay legible at once.
 *
 * THE PLOT IS SIZED TO THE DATA
 * -----------------------------
 * A fixed card height is what puts a canyon between two days, so the container
 * is sized from the day count by `dailyPlotHeight` and the bands are spaced by
 * `barCategoryGap`. No scroll region, no negative margins, no `scale()`: the box
 * is the right size and recharts lays the bars out in it.
 *
 * THE BARS ARE AS THICK AS THEIR ROWS ALLOW
 * -----------------------------------------
 * Thickness is the last step of one relationship, not a number of its own: the
 * day count sizes the box, the box gives every day a band, and `dailyBarSize`
 * decides how much of that band the bar may fill (see `dailyBar.ts`). It is a
 * cap rather than a target, so a two-day period cannot produce two hairlines
 * marooned in a tall card and a month cannot produce slabs that collide. The bar
 * is not scaled, stretched or overlaid to achieve any of it.
 *
 * A DAY MAY ASK FOR ITS OWN COLOUR
 * --------------------------------
 * Some series have a real second reading to show through the fill — a day of
 * many small expenses against a day of one big one. Which day is which is a
 * property of the DATA and is decided by the adapter that owns the business, so
 * a datum may carry a `color`; this chart resolves the fill per bar
 * ({@link dailyBarFill}) and has no idea why. Every colour is still a
 * centralized `var(--chart-bar-*)` role, so Dev Settings repaints all of them at
 * once and nothing here can leak a literal.
 *
 * A DATE IS ONE LINE, ALWAYS
 * --------------------------
 * recharts breaks a tick into two `<tspan>` lines only when it is HANDED a width
 * to break at, which is exactly what a narrow category axis does to a long Arabic
 * date. The day axis is therefore given a column wide enough for the project's
 * own date string (`DAILY_DAY_AXIS_WIDTH`) and the tick is told not to wrap. The
 * date itself is never shortened, split, ellipsised or reformatted to make room:
 * it is printed by the central formatter, in full, on one line, in RTL, in light
 * mode, in dark mode and in fullscreen alike.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * There is no trend line, no trend arrow and no "Trending up/down" reading over
 * the bars. A daily chart's job is to state what each day WAS; a trend is a
 * statement about the PAIR of days, it is stated once, in words, by whoever owns
 * the page, and drawing it a second time as a line through the data only
 * competes with the values it is supposed to summarize. The peak day survives,
 * because a peak is a fact about ONE day rather than a movement.
 */
import { useMemo, type ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Rectangle,
  Text,
  XAxis,
  YAxis,
  type BarShapeProps,
  type YAxisTickContentProps,
} from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ChartShell, type ChartPresentation } from './ChartShell'
import {
  DAILY_DAY_AXIS_WIDTH,
  canLabelBars,
  dailyBarCategoryGap,
  dailyBarFill,
  dailyBarSize,
  dailyMetricValue,
  dailyPlotHeight,
  dayTotal,
  peakDay,
  type DailyBarDatum,
  type DailyBarSeries,
  type DailyTooltipMetric,
} from './dailyBar'
import { formatChartValue, type ChartValueStyle } from './chartValue'
import { seriesTooltipName, seriesTooltipValue } from './monthlyComparison'

/** The shared Arabic word for a total, matching the reports charts' tooltip row. */
const DEFAULT_TOTAL_LABEL = 'الإجمالي'
/** The shared Arabic word for the tooltip's day heading. */
const DEFAULT_DATE_LABEL = 'التاريخ'

/**
 * Any figure this chart states: a plotted bar, or a real reading of the day
 * that is stated in the tooltip without being drawn. Both declare a key, an
 * Arabic label, a semantic type and an optional formatter of their own, which is
 * exactly what the shared tooltip helpers need.
 */
type DailyFigure = DailyBarSeries | DailyTooltipMetric

/**
 * One bar, painted in the colour ITS OWN day asked for.
 *
 * recharts draws the rectangle itself by default, with one fill for the whole
 * series; a custom `shape` is how a single mark resolves its own. The shape is
 * the stock `Rectangle` with a fill resolved through {@link dailyBarFill}, so
 * the bar keeps recharts' own geometry, rounding and event handling — the only
 * thing that changes is which centralized role it is painted with. Nothing here
 * knows or asks why one day differs from the next.
 */
function renderBarShape(series: DailyBarSeries) {
  return function BarShape(props: BarShapeProps) {
    return <Rectangle {...props} fill={dailyBarFill(props.payload, series)} />
  }
}

/**
 * One shape renderer per series, remembered.
 *
 * The renderer is what recharts asks for a bar, not a component it mounts, so
 * this is about not rebuilding it on every period change rather than about
 * remounting anything. Either way the RESULT is a fill resolved per bar.
 */
function useBarShapes(series: readonly DailyBarSeries[]) {
  return useMemo(() => new Map(series.map((item) => [item.key, renderBarShape(item)])), [series])
}

/**
 * A day label that is ONE line, by construction.
 *
 * recharts' own tick breaks its text into as many `<tspan>` lines as the WIDTH
 * it is given requires — a long Arabic date in a 92px column becomes two lines,
 * which is the fault this replaces. Dropping `width` from the tick is what
 * actually stops the break (recharts then measures nothing and prints the words
 * as one run), and `white-space: nowrap` states the same intent to the SVG. The
 * text itself is untouched: same formatter, same string, same order, and the
 * same right-anchored alignment the axis would have used.
 */
function DayLabelTick({
  width: _breakWidth,
  payload,
  tickFormatter,
  index,
  ...tick
}: YAxisTickContentProps) {
  // The value is read off the tick's own payload — the formatter, the string and
  // the order are recharts' own, so this changes the BREAKING and nothing else.
  const value = payload?.value
  const label = typeof tickFormatter === 'function' ? tickFormatter(value, index) : value
  return (
    <Text {...tick} style={{ whiteSpace: 'nowrap' }}>
      {label as string | number}
    </Text>
  )
}

export type DailyBarChartProps = {
  /** Stable id: it namespaces the fullscreen trigger and the chart element. */
  id: string
  title: string
  description?: string
  /** Period line, already formatted for the reader. */
  period?: string
  /** One entry per DAY, ascending by day. */
  data: readonly DailyBarDatum[]
  /** The plotted measure. Each series declares what its values MEAN. */
  series: readonly DailyBarSeries[]
  /**
   * Figures the day REALLY carries that must not be drawn as bars — a count, an
   * average — stated under the tooltip rows, in the same semantic form as a
   * series. A row is printed only for a day that actually carries the value, so
   * a metric can never print a `0` nobody measured.
   */
  metrics?: readonly DailyTooltipMetric[]
  /**
   * The Arabic name of the DATE, as the tooltip's heading reads it. Localized by
   * the page, because "التاريخ" is a word the page owns.
   */
  dateLabel?: string
  /**
   * The Arabic words for the PEAK DAY, and the chart states it in the toolbar.
   *
   * The chart already knows the peak — it is the largest value of the plotted
   * series, read from the very data the bars are — so the page passes only the
   * WORDS and the chart owns the layout. That is what keeps the peak readable
   * (`أعلى يوم` strong, the day and its figure secondary) and keeps two pages
   * from growing two competing implementations of the same badge.
   */
  peakLabel?: string

  /**
   * States the period total in the tooltip footer and the card footer. Off by
   * default because a chart whose series do not compose one total (Cash vs Card)
   * must never claim that they do.
   */
  showTotal?: boolean
  /**
   * Forces the value labels on or off. Left unset they follow the data density —
   * see {@link canLabelBars} — because overlapping labels are worse than none.
   */
  showBarLabels?: boolean
  /** The Arabic name of the total row, so a page can localize the footer. */
  totalLabel?: string
  /**
   * Extra toolbar content, rendered beside the fullscreen and export buttons —
   * the same slot the monthly chart's month-over-month badge uses. A page puts
   * its own peak reading here, so that fact travels with the chart into
   * fullscreen instead of being lost on the inline card only.
   */
  toolbarExtra?: ReactNode
  onExportPng?: () => void | Promise<void>
  onExportExcel?: () => void | Promise<void>
  presentation?: ChartPresentation
  className?: string
}

export function DailyBarChart({
  id,
  title,
  description,
  period,
  data,
  series,
  metrics = [],
  dateLabel,
  peakLabel,
  showTotal = false,
  showBarLabels,
  totalLabel,
  toolbarExtra,
  onExportPng,
  onExportExcel,
  presentation = 'card',
  className,
}: Readonly<DailyBarChartProps>) {
  const primary = series[0]
  const barShapes = useBarShapes(series)

  // The theme colours reach recharts as `--color-<key>` custom properties, which
  // is the same contract the monthly comparison chart publishes; the bar fill
  // below reads them rather than repeating a literal.
  const chartConfig = useMemo(
    () =>
      Object.fromEntries(
        series.map((item) => [item.key, { label: item.label, color: item.color }]),
      ),
    [series],
  )

  // ONE place decides how any figure of this chart reads: by the type its
  // declaration carries, or by the series' own formatter when it supplies one.
  // A figure whose type nobody declared formats as a plain number — never as
  // money — so the wrong answer is always the harmless one.
  const figures = useMemo(() => [...series, ...metrics] as DailyFigure[], [series, metrics])
  const format = useMemo(
    () =>
      (key: string, value: number, style: ChartValueStyle = 'exact'): string => {
        const entry = figures.find((item) => item.key === key)
        if (entry?.format) return entry.format(value)
        return formatChartValue(value, entry?.type, style)
      },
    [figures],
  )
  // The tooltip's own value resolver, so a hovered row is formatted by the SAME
  // declaration as a bar label and an axis tick — one rule, three surfaces.
  const tooltipValue = (key: string, value: number, style: ChartValueStyle = 'exact') => {
    const entry = figures.find((item) => item.key === key)
    return seriesTooltipValue(figures, key, value, (fallback) =>
      formatChartValue(fallback, entry?.type, style),
    )
  }

  const labelled = showBarLabels ?? canLabelBars(data.length)
  const peak = useMemo(() => (primary ? peakDay(data, primary.key) : null), [data, primary])
  const periodTotal = useMemo(
    () => data.reduce((total, datum) => total + dayTotal(datum, series), 0),
    [data, series],
  )
  const totalText = totalLabel ?? DEFAULT_TOTAL_LABEL
  const dateText = dateLabel ?? DEFAULT_DATE_LABEL
  const peakValue = (value: number) => format(primary?.key ?? '', value)

  // The tooltip HEADING: the day, read from the mark's own datum so the full
  // "٢٧ سبتمبر ٢٠٢٦" is what a reader is shown — never the axis' abbreviated
  // form, and never a raw ISO value. Declared here rather than inline so the
  // tooltip primitive receives a stable render function.
  const renderTooltipLabel = (_label: ReactNode, items?: { payload?: unknown }[]) => {
    const datum = items?.[0]?.payload as DailyBarDatum | undefined
    return (
      <>
        <span className="text-foreground-subtle">{dateText}</span>{' '}
        {datum?.fullLabel ?? datum?.label ?? ''}
      </>
    )
  }

  // The tooltip VALUE: printed AS WHAT IT IS, so a currency series states ج.م
  // through the shared money formatter and a count states `42`. Nothing here
  // infers money from "a number", which is exactly what once produced
  // `عدد الفواتير 0.04 ج.م`.
  const renderTooltipValue = (
    value: unknown,
    _name: unknown,
    item: { dataKey?: string | number; name?: string | number },
  ) => tooltipValue(String(item.dataKey ?? item.name ?? _name), Number(value))

  // Under the rows: the day's other REAL readings — the count of invoices, the
  // average of one — separated by the primitive's own rule so the hierarchy
  // reads primary → secondary.
  const renderTooltipFooter = (items: { payload?: unknown }[]) => {
    const datum = items?.[0]?.payload as DailyBarDatum | undefined
    if (!datum) return null
    const rows = metricRows(datum)
    if (showTotal) {
      rows.push(
        <div key="daily-total" className="flex items-center justify-between gap-4">
          <span className="text-foreground-muted">{totalText}</span>
          <span className="tabular-nums">
            {format(primary?.key ?? '', dayTotal(datum, series))}
          </span>
        </div>,
      )
    }
    return rows.length ? <div className="flex w-full flex-col gap-1.5">{rows}</div> : null
  }

  // The secondary readings of one hovered day, each printed ONLY when that day
  // actually carries it — a day with no invoices has no average invoice value,
  // and a `0.00 ج.م` there would state a measurement nobody made. The rows are
  // the same rows and the same labels in the same order whatever the day is, so
  // a reader who has learned one tooltip has learned both.
  const metricRows = (datum: DailyBarDatum) =>
    metrics.flatMap((metric) => {
      const value = dailyMetricValue(datum, metric.key)
      if (value === null) return []
      return [
        <div key={metric.key} className="flex items-center justify-between gap-4">
          <span className="truncate font-bold text-foreground-muted">{metric.label}</span>
          <span className="font-medium tabular-nums text-foreground">
            {format(metric.key, value)}
          </span>
        </div>,
      ]
    })

  // The peak is stated in ONE place, and only when there is one: a period of
  // zeroes has no peak day, and inventing a "highest" reading of nothing would
  // be a measurement nobody made.
  //
  // It reads as ONE highlighted unit, not as a bold heading followed by muted
  // metadata: the label, the day and the figure are the same single fact, so
  // they share one weight, one colour and one hand. The green is the project's
  // centralized `success` token (`text-success`, the same tone the monthly
  // chart's own reading uses) — never a literal, never the Station brown, and
  // never a status colour borrowed from an error. It is a summary treatment
  // ONLY: it says nothing about which bar is which, and the bars keep the
  // Sales/Expenses chart roles they are painted with.
  const peakBadge =
    peakLabel && peak && peak.value > 0 ? (
      <span
        className="flex items-center gap-2 whitespace-nowrap text-caption font-bold text-success"
        data-testid="daily-chart-peak"
      >
        <span>{peakLabel}</span>
        {/* The day and its figure, in the series' own semantic formatter and in
            the order the formatter produces — the reader's RTL, not a re-order. */}
        <span className="tabular-nums">
          {peak.datum.fullLabel ?? peak.datum.label} — {peakValue(peak.value)}
        </span>
      </span>
    ) : null

  // The screen-reader summary states the WHOLE period, not one bar: the peak day
  // is what a manager is looking for, and the total is the figure the tooltip
  // footer already shows, so the two can never disagree.
  const summary = [
    title,
    period,
    peak && peak.value > 0
      ? `${peak.datum.fullLabel ?? peak.datum.label}: ${peakValue(peak.value)}`
      : '',
    showTotal ? peakValue(periodTotal) : '',
  ]
    .filter(Boolean)
    .join(' — ')

  const body = (mode: ChartPresentation) => (
    <>
      {/*
        The plot reads left-to-right like the calendar; its labels do not.

        # The phone treatment, and why it is a contained scroll
        *
        This chart reserves a FIXED 148px for the day column plus 76px for the
        value labels — 224px, which is 76% of the 296px a 320px screen actually
        has once the page and card padding are taken off. Squeezing the plot into
        what is left would produce a chart of 70px-wide bars, and a chart that
        small says nothing; the alternative, shortening the Arabic date, is
        forbidden by this component's own contract (the date is never split,
        truncated or abbreviated, and there is a test that pins it).
        *
        So the third option is taken deliberately: below `sm` the plot gets a
        minimum width and the SCROLL IS THE PLOT'S OWN, inside the card.
        *
        * `min-w-[22rem]` is 352px — the smallest width at which a 148px date
          column, a real bar and a 76px figure column coexist without any of
          them being squeezed;
        * `overflow-x-auto` + `overscroll-x-contain` keep that scroll INSIDE the
          card: a horizontal swipe that reaches its end is contained rather than
          handed to the page, so the whole screen never slides sideways;
        * the negative inline margins + matching padding bleed the scroller to
          the screen edge, so a partly-visible bar reads as "there is more this
          way" rather than as a clipped chart, and the first day still lines up
          with the rest of the card;
        * `sm:` restores `min-w-0` and no scroller, which is the desktop chart
          exactly as it was.

        This is the case the "add overflow-x-auto" advice is about: a scroll
        region introduced HERE, on purpose, where the alternative is either an
        illegible chart or a shortened date — not a scroll region sprinkled over
        a layout that was never measured.
      */}
      <div className="-mx-4 overflow-x-auto overscroll-x-contain px-4 sm:mx-0 sm:overflow-x-visible sm:px-0">
        <div
          dir="ltr"
          className={cn(
            'relative min-h-0 min-w-88 sm:min-w-0 sm:w-full',
            // The height is the DATA's height, not a card's: a two-day period is
            // two compact rows, a fortnight is comfortable, a month is bounded.
            // In fullscreen the same figure is additionally capped against the
            // viewport, so the dialog uses the screen it has without demanding
            // more of it than a laptop has. `shrink-0` then keeps whichever
            // height was resolved — a `flex-1` would let the plot collapse and
            // hand its space to whatever sits below it.
            mode === 'fullscreen' ? 'mt-4 shrink-0' : 'mt-5',
          )}
          style={{ height: `min(62dvh, ${dailyPlotHeight(data.length, mode)}px)` }}
          data-testid="daily-chart-plot"
        >
          <ChartContainer
            id={id}
            config={chartConfig}
            className="[&_.recharts-text]:fill-foreground"
          >
            {/* `layout="vertical"` is what makes a DAY a ROW: the CATEGORY axis is
              the Y axis, the VALUE axis is the X axis, and every bar extends
              horizontally out of the value axis. */}
            <BarChart
              layout="vertical"
              data={[...data]}
              margin={{ top: 4, right: 76, bottom: 4, left: 8 }}
              barCategoryGap={dailyBarCategoryGap}
              barGap={0}
            >
              {/* The grid follows the bars: vertical rules, so the eye reads ACROSS
                a row to its figure rather than up a column. */}
              <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
              {/* The VALUE axis. Its ticks are the scale, so they are abbreviated:
                an axis is not a place to spend a line of digits.

                `xAxisId`/`yAxisId` below are NOT decoration: recharts binds a
                `Bar` to its axes by those two props, and `id` is only a DOM id.
                A bar that names axes which do not carry those ids is bound to
                nothing, and recharts then hands it a degenerate band scale — the
                bars collapse onto each other at the edges of the plot with an
                11px height, so one mark is all a reader ever sees. Every axis
                named by a bar below therefore names itself the same way. */}
              <XAxis
                id="value"
                xAxisId="value"
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => format(primary?.key ?? '', value, 'compact')}
                minTickGap={24}
              />
              {/* The CATEGORY axis: one row per day, in the app's Arabic date form.
                The column is wide enough for the WHOLE date — that width is what
                keeps it on one line, and the tick below is told never to break
                it, so the label is never split or shortened to fit. Thinning,
                not scrolling: a long period drops ticks rather than growing a
                scroll region inside the card. */}
              <YAxis
                id="days"
                yAxisId="days"
                type="category"
                dataKey="label"
                tickLine={false}
                axisLine={false}
                width={DAILY_DAY_AXIS_WIDTH[mode]}
                tick={DayLabelTick}
                interval="preserveStartEnd"
                minTickGap={2}
              />

              {/* `axisId` names the axis the TOOLTIP reads, and it is NOT optional
                decoration. recharts' `Tooltip` defaults to `axisId={0}`, but the
                day axis below is registered under `"days"` (that name is what
                binds the `Bar` to it), so the tooltip was resolving an axis that
                does not exist: recharts' `selectTooltipAxis` then fell back to
                `implicitYAxis` — a `type: "number"` axis with no `dataKey` — and
                built its band from a NUMERIC domain instead of the seven days.
                That is why only ~2 rows ever activated: the pointer was being
                mapped onto a two-point numeric scale, so it resolved to day 0
                for the top half of the plot and day 1 for the bottom half, and
                the tooltip was "correct" for the wrong day.

                Naming the axis is the whole fix, and it is recharts' own
                supported API — not `shared={false}` and not a hit-area overlay. */}
              <ChartTooltip
                axisId="days"
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={renderTooltipLabel}
                    // Each ROW is about ONE figure and is named by the CHART'S OWN
                    // Arabic label for it, never by the mark's key. The day is
                    // already the heading above.
                    itemLabel={(_item, key) => seriesTooltipName(figures, key)}
                    // The name is what the manager is looking for in a row of
                    // figures, so it carries the project's bold weight.
                    boldItemLabel
                    formatter={renderTooltipValue}
                    footer={metrics.length || showTotal ? renderTooltipFooter : undefined}
                  />
                }
              />

              {series.map((item) => (
                <Bar
                  key={item.key}
                  dataKey={item.key}
                  name={item.key}
                  // The bars belong to the value axis, so they grow out of it
                  // sideways; the day axis is what lays them out in rows.
                  xAxisId="value"
                  yAxisId="days"
                  fill={`var(--color-${item.key})`}
                  // A horizontal bar rounds at the end it grows towards.
                  radius={[0, 4, 4, 0]}
                  // Per-BAR colour: the datum may name a different centralized role
                  // for its own day, and the shape resolves it. A datum that names
                  // none — every Sales day — paints exactly the series colour above.
                  shape={barShapes.get(item.key)}
                  // The ceiling, derived from the row this period's box gives each
                  // day: substantial for a short period, naturally thinned for a
                  // long one, and never larger than the band it sits in.
                  maxBarSize={dailyBarSize(data.length, mode)}
                  isAnimationActive={false}
                >
                  {labelled ? (
                    <LabelList
                      dataKey={item.key}
                      fontSize={11}
                      offset={10}
                      // Beside the bar it labels, on the side the bar grows into.
                      position="right"
                      className="fill-foreground"
                      // The bar's own figure, in the SERIES' OWN type: a money bar
                      // ends in ج.م and a counted bar ends in a whole number. The
                      // `auto` style keeps the figure exact until it is long enough
                      // to crowd its own bar, then abbreviates it.
                      formatter={(value: unknown) => format(item.key, Number(value), 'auto')}
                    />
                  ) : null}
                </Bar>
              ))}
            </BarChart>
          </ChartContainer>
          <span className="sr-only" role="img" aria-label={summary} />
        </div>
      </div>

      {/* The footer states the period total, so a reader who never hovers a bar
          still gets the figure the whole chart is about. */}
      {showTotal ? (
        <div
          className="mt-3 flex items-baseline justify-between gap-3 border-t border-border-subtle pt-3"
          data-testid="daily-chart-summary"
        >
          <span className="text-caption text-foreground-subtle">{totalText}</span>
          <span className="text-body font-bold tabular-nums text-foreground-strong">
            {peakValue(periodTotal)}
          </span>
        </div>
      ) : null}
    </>
  )

  return (
    <ChartShell
      id={id}
      title={title}
      description={description}
      period={period}
      // The peak travels in the toolbar, exactly where the monthly chart puts
      // its month-over-month reading, so it is still there in fullscreen — and
      // it is stated ONCE, beside whatever else the page puts in this slot.
      toolbarExtra={
        peakBadge || toolbarExtra ? (
          <>
            {peakBadge}
            {toolbarExtra}
          </>
        ) : null
      }
      onExportPng={onExportPng}
      onExportExcel={onExportExcel}
      presentation={presentation}
      className={className}
      testId={`daily-chart-${id}`}
    >
      {body}
    </ChartShell>
  )
}
