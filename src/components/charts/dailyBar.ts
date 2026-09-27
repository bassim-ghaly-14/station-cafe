/**
 * dailyBar — the pure model behind the reusable DAILY bar chart.
 *
 * Everything here is arithmetic, typing and formatting decisions; no React, no
 * recharts, no i18n, no money rules. It exists so the two questions a daily
 * chart has to answer can be tested without rendering anything:
 *
 *  1. how one business day becomes a labelled category and a bar value; and
 *  2. whether the value is dense enough to be printed ON the bar.
 *
 * It is the DAILY counterpart of `monthlyComparison.ts`, and it is deliberately
 * built from the SAME two ideas so the two charts cannot drift:
 *  - the stable `YYYY-MM-DD` day key, which is the day's identity across years,
 *    with a short label for a dense axis and a full one for the tooltip and the
 *    export, so a period crossing new year is never ambiguous;
 *  - `seriesTooltipName` / `seriesTooltipValue`, which are re-exported from the
 *    monthly model rather than reimplemented, so a row reads by its Arabic name
 *    in bold and never by its internal series key.
 *
 * A future page can point the same chart at Cash vs Card, this week vs last week,
 * or a POS hour-by-hour, by passing different `series` and `data` — this file has
 * no idea whether it is looking at revenue, spend, or weather.
 */

import type { ChartValueType } from './chartValue'

/** One day of the period, as the backend reported it. */
/**
 * A day may ask for its own bar COLOUR, without the chart knowing why.
 *
 * The fill a bar is drawn with is a CENTRALIZED chart role, and some series have
 * a real second reading to show through it — a day of many small expenses against
 * a day of one big one, say. That is a property of the DATA, decided by the
 * adapter that owns the business (it is the only place that knows what a count
 * means), so the datum carries the colour it wants and this chart simply draws
 * what it is handed. It is optional, it is a `var(--chart-bar-*)` reference like
 * every other bar colour, and a datum that says nothing keeps the series colour.
 */
export type DailyBarDatum = {
  /** The axis label, already formatted for display by the caller. */
  label: string
  /** The fuller date the tooltip and the export print. */
  fullLabel?: string
  /**
   * This day's own bar colour — a CENTRALIZED chart bar role, never a literal.
   * Absent (the normal case) means "paint me the series colour".
   */
  color?: string
  [seriesKey: string]: string | number | undefined
}

export type DailyBarSeries = {
  /** Property name on {@link DailyBarDatum}. */
  key: string
  /** The Arabic display name — the ONLY name the tooltip ever prints. */
  label: string
  /**
   * A CENTRALIZED chart bar role (`chartBarColor(...)`, i.e. `var(--chart-bar-*)`),
   * never a raw palette value and never a per-chart brand colour — so a bar in
   * any chart of the application is themed and Dev-Settings controlled alike.
   */
  color: string
  /**
   * What the values MEAN, so the formatter can print them as what they are.
   *
   * It is required, not optional, and that is the whole point: a value with no
   * declared type is a value nobody has taken responsibility for, and the one
   * bug this file's chart used to have — an invoice COUNT rendered as
   * `0.04 ج.م` — is what "optional, default to money" produces. `currency` is
   * stated by the page that stores piastres; `count` by the page that stores
   * how many of something there were.
   */
  type: ChartValueType
  /** Optional per-series value formatting for the tooltip and the axis. */
  format?: (value: number) => string
}

/**
 * A figure the day REALLY carries, stated in the tooltip without being a bar.
 *
 * A daily chart plots one measure — the money — because a count of 2 beside an
 * amount of 24,000 would be an invisible bar. That is a reason not to DRAW the
 * count, and no reason at all to hide it: the count is a real reading of that
 * day, already aggregated by the backend, and a manager reads this chart to see
 * "many small tickets" against "one big ticket". A metric is therefore stated
 * with the same semantic care as a series — a key, an Arabic label and a type —
 * and is printed only for a day that actually carries it.
 */
export type DailyTooltipMetric = {
  /** Property name on {@link DailyBarDatum}. */
  key: string
  /** The Arabic display name — the ONLY name the tooltip ever prints. */
  label: string
  /** What the value means, resolved by the shared semantic formatter. */
  type: ChartValueType
  /** Optional per-metric value formatting, exactly as a series has. */
  format?: (value: number) => string
}

/**
 * How many days may carry a printed value before the labels are dropped.
 *
 * A daily chart can be asked for a whole quarter, and thirty labels of a money
 * figure across one plot is not information — it is a smear. The bar height still
 * states the value, the axis still states the scale and the tooltip still states
 * the exact figure, so nothing is LOST by not printing it; it is only less
 * readable. Above the limit the chart therefore says nothing on the bars.
 *
 * The threshold is deliberately generous (a month of days) because these labels
 * are short and the plot is wide; it exists to catch a 90-day window, not to
 * ration a normal month.
 */
export const MAX_LABELLED_DAYS = 31

/** Whether the values may be printed on the bars, given how many days there are. */
export function canLabelBars(dayCount: number): boolean {
  return dayCount > 0 && dayCount <= MAX_LABELLED_DAYS
}

/** Read one series value off a day, treating a gap as zero. */
export function dailyValue(datum: DailyBarDatum, key: string): number {
  const raw = datum[key]
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : 0
}

/**
 * The colour ONE bar is painted with: the day's own, if it asked for one, and
 * the series' role otherwise.
 *
 * This is the whole of the per-bar variation contract, and it is deliberately
 * ignorant of WHY a day might want a different colour — the chart resolves a
 * fill, it does not interpret a business. A day that carries no colour (every
 * Sales day, and every Expenses day with a single expense) therefore resolves to
 * the series role, which is what keeps the two pages from drifting apart.
 */
export function dailyBarFill(datum: DailyBarDatum, series: DailyBarSeries): string {
  return datum.color ?? series.color
}

/**
 * Read a TOOLTIP metric off a day — and tell "absent" from "zero".
 *
 * {@link dailyValue} is right for a bar, where a day that touched nothing is a
 * zero-length bar. It is wrong for a metric, where a key the day simply does not
 * carry (`average_invoice` on a day with no invoices) is not a reading of zero —
 * printing `0.00 ج.م` there would state a measurement nobody made. So this
 * returns `null` and the row is not printed at all.
 */
export function dailyMetricValue(datum: DailyBarDatum, key: string): number | null {
  const raw = datum[key]
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : null
}

/** The sum of every configured series for one day — the day's total. */
export function dayTotal(datum: DailyBarDatum, series: readonly DailyBarSeries[]): number {
  return series.reduce((total, item) => total + dailyValue(datum, item.key), 0)
}

/** The sum of a series across the whole period. */
export function seriesTotal(data: readonly DailyBarDatum[], key: string): number {
  return data.reduce((total, datum) => total + dailyValue(datum, key), 0)
}

/** The largest single value in the period, and the day it belongs to. */
export function peakDay(
  data: readonly DailyBarDatum[],
  key: string,
): { datum: DailyBarDatum; value: number } | null {
  let best: { datum: DailyBarDatum; value: number } | null = null
  for (const datum of data) {
    const value = dailyValue(datum, key)
    if (!best || value > best.value) best = { datum, value }
  }
  return best
}

/**
 * COMPACTNESS: the plot is sized to the DATA, not to a card.
 * -------------------------------------------------------
 * Recharts always divides the height it is given between the categories it is
 * given, so a fixed 18rem card asked to draw two days produces two slabs with a
 * canyon of empty card between them — the "wasteful and disconnected" reading a
 * short period should never have. So the height is DERIVED from the day count:
 * one comfortable row per day, a floor so a one-day period is still a card, and
 * a ceiling so a month of days still fits without a scroll region.
 *
 * These are ordinary layout numbers fed to the container as its height. There is
 * no `scale()`, no negative margin, no absolute positioning and no internal
 * scrollbar anywhere in this strategy: recharts is asked for a box of the right
 * size and lays the bands out in it, which is the only way a bar keeps meaning
 * its own value.
 */
/** Vertical room one day's band needs to stay readable (bar + a little air). */
export const DAILY_ROW_HEIGHT = { card: 38, fullscreen: 50 } as const
/** The value axis, the margin and the room the first bar needs beside itself. */
export const DAILY_PLOT_CHROME = { card: 44, fullscreen: 64 } as const
/** Below this the plot would be a line of text; above it the page takes over. */
export const DAILY_PLOT_RANGE = {
  card: { min: 112, max: 420 },
  fullscreen: { min: 280, max: 760 },
} as const

/**
 * The plot height for a period of `dayCount` days, in pixels.
 *
 * A daily chart is presented in two sizes and both are asked for the same
 * question, so the two can never disagree about how tall a day is:
 *  - `card` — inside the page, compact: two days are two rows, not two slabs
 *    marooned in a fixed card;
 *  - `fullscreen` — inside the dialog, roomier per row, and bounded by a `dvh`
 *    ceiling the caller applies, so it uses the space it is given without ever
 *    demanding more of a screen than the screen has.
 */
export function dailyPlotHeight(
  dayCount: number,
  presentation: 'card' | 'fullscreen' = 'card',
): number {
  const range = DAILY_PLOT_RANGE[presentation]
  const rows = Math.max(dayCount, 1)
  const wanted = rows * DAILY_ROW_HEIGHT[presentation] + DAILY_PLOT_CHROME[presentation]
  return Math.min(range.max, Math.max(range.min, wanted))
}

/**
/**
 * The gap between one day's band and the next, as a PERCENTAGE of the band.
 *
 * Small, because the bands are already sized to the data by
 * {@link dailyPlotHeight}: once the container is compact a large
 * `barCategoryGap` would re-open the canyon, and once the container is full the
 * gap is all that keeps neighbouring days from reading as one bar.
 *
 * It is the OTHER side of the same relationship {@link dailyBarSize} describes:
 * the bar takes the rest of the band, its neighbours' share is what is left, and
 * a gap that grew while the bar shrank is exactly the thin-bar fault in reverse.
 *
 * IT MUST REACH RECHARTS AS A PERCENT STRING. recharts reads `barCategoryGap` as
 * a percentage only when it is written `'12%'`; handed the NUMBER `12` it means
 * twelve PIXELS on each side, and a compact band is then
 * `bandSize - 24` — which is zero, or negative, and a negative band size is a bar
 * of negative thickness: no bar at all. {@link DAILY_BAR_CATEGORY_GAP} is
 * therefore a plain number here and a `'…%'` string at the point of use.
 */
export const DAILY_BAR_CATEGORY_GAP = 12

/** The value recharts must be handed for {@link DAILY_BAR_CATEGORY_GAP}. */
export const dailyBarCategoryGap = `${DAILY_BAR_CATEGORY_GAP}%` as const

/**
 * BAR THICKNESS IS A RELATIONSHIP, NOT A CONSTANT
 * ---------------------------------------------
 * A bar's height is not a number someone picked: it is what is left of its own
 * row once the neighbouring rows have taken their share of the gap. So the chain
 * runs in one direction only —
 *
 *     day count → row height (this file) → bar thickness → category gap
 *
 * {@link dailyPlotHeight} decides the box, this function decides how much of a
 * band the bar fills, and `barCategoryGap` is the same proportion expressed on
 * the OTHER side of the band. Raising one without the others is what produces a
 * hairline bar in a huge row (the fault this replaces) or two slabs colliding.
 *
 * The tiers exist because the space is not linear: a two-day period is a
 * generous box, a fourteen-day period is a tight one, and a month has to stay
 * legible rather than comfortable.
 *
 * Every tier is bounded TWICE, and the second bound is the one that matters:
 * not only by {@link DAILY_BAR_MAX_SIZE}, but by the band the box actually
 * leaves over once a long period has been clamped to its ceiling. A cap that
 * ignored that would ask recharts for a 25px bar inside a 12px band, and the
 * bars would be drawn taller than the rows they belong to — overlapping each
 * other exactly as invisibly as they hid before. A cap is only a cap if it
 * cannot exceed what is there.
 */
export const DAILY_BAR_FILL = { card: 0.84, fullscreen: 0.86 } as const

/** The thickest a bar may ever be drawn, per presentation — elegance, not slabs. */
export const DAILY_BAR_MAX_SIZE = { card: 34, fullscreen: 44 } as const

/** How many days each thickness tier covers, the longest period last. */
export const DAILY_BAR_TIERS = [
  { upTo: 3, fill: 0.82 },
  { upTo: 7, fill: 0.78 },
  { upTo: 15, fill: 0.72 },
  { upTo: Number.POSITIVE_INFINITY, fill: 0.66 },
] as const

/**
 * The vertical band one day really gets, in pixels: the box the period is drawn
 * in, less the axis and the margins recharts reserves, divided by the days.
 *
 * It is derived from the SAME {@link dailyPlotHeight} the container is given, so
 * it is the real thing rather than an estimate of it — and it is why a long
 * period's bars are thinned by their actual room instead of by a guess.
 */
export function dailyBandHeight(
  dayCount: number,
  presentation: 'card' | 'fullscreen' = 'card',
): number {
  const rows = Math.max(dayCount, 1)
  return Math.max(
    (dailyPlotHeight(dayCount, presentation) - DAILY_PLOT_CHROME[presentation]) / rows,
    1,
  )
}

/**
 * The `maxBarSize` this chart asks recharts for, given the period and the
 * presentation, in pixels.
 *
 * It is a CAP, never a target: the box is sized first, recharts then divides it
 * between the days it was given, and a bar is finally held to this ceiling. A
 * one- or two-day period therefore lands on a genuinely substantial bar, a
 * fortnight is comfortable, and a month is thinned by the space it actually has
 * rather than by anything a reader has to be told about.
 */
export function dailyBarSize(
  dayCount: number,
  presentation: 'card' | 'fullscreen' = 'card',
): number {
  const rows = Math.max(dayCount, 1)
  const tier = DAILY_BAR_TIERS.find((candidate) => rows <= candidate.upTo) ?? DAILY_BAR_TIERS[0]
  const wanted = Math.round(
    DAILY_ROW_HEIGHT[presentation] * Math.min(tier.fill, DAILY_BAR_FILL[presentation]),
  )
  // The band the days REALLY get, which a clamped long period is much smaller
  // than the nominal row. The band wins outright: a floor of "always at least a
  // few pixels" would ask for a 6px bar inside a 4px band, and a bar taller than
  // its row is drawn on top of its neighbours — the very fault this model exists
  // to prevent. A 90-day period is a 4px bar because a 90-day period is 4px.
  const band = Math.floor(dailyBandHeight(dayCount, presentation))
  return Math.max(1, Math.min(wanted, DAILY_BAR_MAX_SIZE[presentation], band))
}

/**
 * The width the day axis is given, in pixels.
 *
 * The date is the project's own Arabic string and it is never shortened to fit;
 * the COLUMN is widened instead. recharts only breaks a tick into two `<tspan>`
 * lines when it is handed a width to break at, so this number is what actually
 * keeps `السبت، ٢٧ سبتمبر ٢٠٢٦` on ONE line — the text is never split,
 * truncated or ellipsised, and the date formatter is left exactly as it is.
 */
export const DAILY_DAY_AXIS_WIDTH = { card: 148, fullscreen: 172 } as const
