/**
 * What the daily chart owes its reader, and what it borrows from the app.
 *
 * recharts is real here, with only the sizing wrappers unwrapped: a zero-sized
 * chart renders no children at all, and the tooltip's `content` is a PROP rather
 * than rendered output, so both have to be replaced to be asserted on. The plot
 * element and the axes are captured as PROPS rather than probed through
 * recharts' SVG, because what matters is the CONFIGURATION a reader sees — a
 * horizontal layout, a category axis of days, a compact box — and not the
 * thousands of path coordinates recharts would draw from it. Every other
 * recharts piece, the real tooltip primitive and the chart under test are the
 * production ones.
 *
 * The things proved here are the ones a reader would notice breaking: the bars
 * are horizontal ROWS, the plot is compact, the tooltip speaks Arabic only and
 * formats every value AS WHAT IT IS, the peak day is stated in a strong hand,
 * and fullscreen + export are the shared shell's rather than a second pair.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { CURRENCY_LABEL } from '@/lib/money'
import {
  DAILY_BAR_CATEGORY_GAP,
  DAILY_DAY_AXIS_WIDTH,
  dailyBandHeight,
  dailyBarCategoryGap,
  dailyBarSize,
  dailyPlotHeight,
  type DailyBarDatum,
  type DailyBarSeries,
  type DailyTooltipMetric,
} from './dailyBar'

/**
 * Every tooltip the chart configured, with the PROPS it was configured with.
 * The `content` element is captured alongside the rest, so a test can assert on
 * the interaction MODE (`axisId`, `shared`, `trigger`) as well as on the content
 * that gets rendered.
 */
const tooltips: Record<string, unknown>[] = []
/** The plot element props the chart hands to recharts, per render. */
const plots: Record<string, unknown>[] = []
/** Every bar the chart drew, with the props it was configured with. */
const bars: Record<string, unknown>[] = []
/** Every axis the chart configured, tagged with which axis it was. */
const axes: Record<string, unknown>[] = []

/** Renders its children with no box of its own. */
const passThrough = ({ children }: { children?: ReactNode }) => <>{children}</>

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: passThrough,
    // The plot element's own PROPS are what this contract is about — a
    // horizontal layout, a category axis of days, a compact band gap — but its
    // children still have to MOUNT, because that is how the tooltip content and
    // the axes get configured at all.
    BarChart: (props: { children?: ReactNode } & Record<string, unknown>) => {
      plots.push(props)
      return <>{props.children}</>
    },
    // The bars are the chart's primary marks, so what the chart ASKS of them —
    // how thick a band they may fill, and whether each one resolves its own fill
    // — is part of this contract. Their geometry is recharts' job and is not
    // re-implemented here.
    Bar: (props: { children?: ReactNode } & Record<string, unknown>) => {
      bars.push(props)
      return <>{props.children}</>
    },
    XAxis: (props: Record<string, unknown>) => {
      axes.push({ axis: 'x', ...props })
      return null
    },
    YAxis: (props: Record<string, unknown>) => {
      axes.push({ axis: 'y', ...props })
      return null
    },
    Tooltip: (
      props: { content?: ReactElement<Record<string, unknown>> } & Record<string, unknown>,
    ) => {
      // Two things, deliberately: the TOOLTIP's own props at the top level
      // (`axisId`, `shared`, `trigger` — the interaction mode), and the
      // `content` element's props under `props`, which is what the tooltip
      // RENDERING tests have always spread.
      if (props.content) tooltips.push({ ...props, props: props.content.props })
      return null
    },
  }
})

const { DailyBarChart } = await import('./DailyBarChart')
const { ChartTooltipContent } = await import('@/components/ui/chart')
type ChartProps = Parameters<typeof DailyBarChart>[0]

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

/** Arabic category names, exactly as the backend's `name_ar` supplies them. */
const EXPENSE_SERIES: DailyBarSeries[] = [
  { key: 'MAINTENANCE', label: 'صيانة', color: 'var(--chart-bar-primary)', type: 'currency' },
  { key: 'ELECTRICITY', label: 'كهرباء', color: 'var(--chart-bar-secondary)', type: 'currency' },
]
/**
 * A counted reading of the same day, exactly as the Sales and Expenses pages
 * declare it: a COUNT, which must never be printed as money.
 */
const EXPENSE_METRICS: DailyTooltipMetric[] = [
  { key: 'invoices', label: 'عدد الفواتير', type: 'count' },
  { key: 'average', label: 'متوسط قيمة الفاتورة', type: 'currency' },
]

// Amounts are stored in piastres, exactly as the backend stores them.
const DATA: DailyBarDatum[] = [
  {
    label: '٢٤ سبتمبر',
    fullLabel: '٢٤ سبتمبر ٢٠٢٦',
    MAINTENANCE: 850_000,
    ELECTRICITY: 120_000,
    invoices: 42,
    average: 202_38,
  },
  {
    label: '٢٥ سبتمبر',
    fullLabel: '٢٥ سبتمبر ٢٠٢٦',
    MAINTENANCE: 300_000,
    ELECTRICITY: 90_000,
    invoices: 12,
    average: 325_000,
  },
]

function renderChart(props: Partial<ChartProps> = {}) {
  return render(
    <DailyBarChart
      id="daily"
      title="المصروفات عبر الأيام"
      data={DATA}
      series={EXPENSE_SERIES}
      metrics={EXPENSE_METRICS}
      dateLabel="التاريخ"
      peakLabel="أعلى يوم"
      {...props}
    />,
  )
}

beforeEach(() => {
  tooltips.length = 0
  plots.length = 0
  bars.length = 0
  axes.length = 0
})

describe('the shape of the plot', () => {
  it('draws a horizontal bar per day: categories on Y, values on X', () => {
    renderChart()

    // `layout="vertical"` is recharts' name for "the categories run down the Y
    // axis and the values along the X" — a day is a ROW and its bar extends
    // sideways. A vertical-column chart is the failure this guards against.
    expect(plots[0]?.layout).toBe('vertical')
    const y = axes.find((axis) => axis.axis === 'y')
    const x = axes.find((axis) => axis.axis === 'x')
    expect(y?.type).toBe('category')
    expect(y?.dataKey).toBe('label')
    expect(x?.type).toBe('number')
    // The day labels need room of their own, or a September date is clipped.
    expect(Number(y?.width)).toBeGreaterThanOrEqual(DAILY_DAY_AXIS_WIDTH.card)
  })

  it('plots one entry per day and never buckets by month', () => {
    renderChart()

    expect(plots[0]?.data).toHaveLength(DATA.length)
  })

  it('carries NO trend visualization: no line, and no second hidden axis', () => {
    renderChart()

    // The trend line this chart used to draw needed a scale of its own, and that
    // scale was a third axis. Two axes means a day axis and a value axis and
    // nothing else: the chart states what each day WAS and leaves movement to the
    // page that owns it.
    expect(axes).toHaveLength(2)
    expect(axes.every((axis) => axis.hide !== true)).toBe(true)
  })
})

describe('a day that must never break onto two lines', () => {
  const LONG_DATE = 'السبت، ٢٧ سبتمبر ٢٠٢٦'

  /** The tick renderer the chart handed to the day axis, last one rendered. */
  function dayTick() {
    return axes.filter((axis) => axis.axis === 'y').at(-1)?.tick as (props: unknown) => ReactNode
  }

  it('renders the whole Arabic date in ONE line, at full length', () => {
    renderChart({ data: [{ label: LONG_DATE, fullLabel: LONG_DATE, MAINTENANCE: 1_000 }] })
    const { container } = render(
      <svg>{dayTick()({ x: 0, y: 0, payload: { value: LONG_DATE } })}</svg>,
    )

    // recharts breaks a tick into several `<tspan>` lines ONLY when it is handed
    // a width to break at, which is how this date used to become two lines. One
    // `<tspan>` is the whole proof: the text is a single unbroken run.
    const text = container.querySelector('text')
    expect(text?.querySelectorAll('tspan')).toHaveLength(1)
    // Nothing is dropped to make it fit: no ellipsis, no shortened date.
    expect(text?.textContent).toBe(LONG_DATE)
    expect(text?.textContent).not.toMatch(/…|\.\.\./)
    expect(text?.getAttribute('style')).toContain('white-space: nowrap')
  })

  it('is never handed the axis width to break at', () => {
    renderChart()
    // The width recharts injects into every tick is the mechanism of the bug.
    const { container } = render(
      <svg>
        {dayTick()({
          x: 0,
          y: 0,
          payload: { value: LONG_DATE },
          width: DAILY_DAY_AXIS_WIDTH.card,
        })}
      </svg>,
    )
    expect(container.querySelector('text')?.getAttribute('width')).toBeNull()
  })

  it('gives the date column enough width, in the card AND in fullscreen', async () => {
    renderChart()
    const card = Number(axes.filter((axis) => axis.axis === 'y').at(-1)?.width)
    expect(card).toBe(DAILY_DAY_AXIS_WIDTH.card)

    fireEvent.click(screen.getByRole('button', { name: /تكبير الرسم البياني/ }))
    await screen.findByRole('dialog')
    // Fullscreen is roomier, never narrower: the same rule, the bigger number.
    const full = Number(axes.filter((axis) => axis.axis === 'y').at(-1)?.width)
    expect(full).toBe(DAILY_DAY_AXIS_WIDTH.fullscreen)
    expect(full).toBeGreaterThan(card)
  })
})

describe('the thickness of the bars', () => {
  /** The ceiling the chart asked recharts for. */
  function cardBarSize(days: number, mode: 'card' | 'fullscreen' = 'card') {
    const data: DailyBarDatum[] = Array.from({ length: days }, (_, index) => ({
      label: `يوم ${index}`,
      MAINTENANCE: 1_000 * (index + 1),
    }))
    bars.length = 0
    renderChart({ data, ...(mode === 'fullscreen' ? { presentation: 'fullscreen' as const } : {}) })
    return Number(bars.at(-1)?.maxBarSize)
  }

  it('draws bars that are SUBSTANTIALLY thicker than the thin implementation', () => {
    // The fault being fixed: `maxBarSize={fullscreen ? 28 : 22}`, which made the
    // chart's primary marks read as hairlines. Wherever the box has room, every
    // period now asks for more.
    for (const days of [1, 2, 3, 5, 7, 14]) {
      expect(cardBarSize(days)).toBeGreaterThan(22)
      expect(cardBarSize(days, 'fullscreen')).toBeGreaterThan(28)
    }
    // And two days — the case that was worst — are now genuinely substantial.
    expect(cardBarSize(2)).toBeGreaterThanOrEqual(28)
  })

  it('keeps the bar a real share of its own row, at every period', () => {
    for (const days of [2, 7, 14, 30]) {
      const size = cardBarSize(days)
      // A bar is a CAP, and a cap that exceeds the band is a bar drawn on top of
      // its neighbours: at 30 days the rows really are ~12px, and the bar must be
      // thinner than the row it belongs to, not thicker.
      expect(size).toBeLessThanOrEqual(Math.floor(dailyBandHeight(days)))
      expect(size).toBeGreaterThan(0)
    }
    // Thinner as the period grows, so a month is never a wall of slabs.
    expect(cardBarSize(2)).toBeGreaterThan(cardBarSize(30))
  })

  it('grows the ceiling in fullscreen, where each day has a taller band', async () => {
    renderChart()
    const card = Number(bars[0]?.maxBarSize)

    fireEvent.click(screen.getByRole('button', { name: /تكبير الرسم البياني/ }))
    await screen.findByRole('dialog')
    expect(Number(bars[bars.length - 1]?.maxBarSize)).toBeGreaterThan(card)
  })

  it('reaches the thickness through recharts, never through a CSS trick', () => {
    renderChart()
    const plot = screen.getByTestId('daily-chart-plot')

    // No `scale()`, no negative margin, no absolute overlay, no clipping and no
    // internal scrollbar: an ordinary box of the right size, a band gap, and a
    // bar ceiling recharts respects.
    expect(plot.className).not.toMatch(/scale|absolute|overflow|max-h-/)
    expect(plot.style.margin).toBe('')
    // A PERCENT string, not a number: recharts reads a bare number as PIXELS,
    // which turns a compact band negative and erases the bar.
    expect(plots[0]?.barCategoryGap).toBe(dailyBarCategoryGap)
    expect(plots[0]?.barCategoryGap).toBe(`${DAILY_BAR_CATEGORY_GAP}%`)
    expect(bars[0]?.maxBarSize).toBe(dailyBarSize(DATA.length))
  })
})

describe('the tooltip reads the DAY axis', () => {
  it('names the axis the days actually live on', () => {
    // The production hover bug, stated as a contract. recharts' `Tooltip`
    // DEFAULTS to `axisId={0}`, and the day axis is registered as `"days"` — the
    // name that binds the `Bar` to it. Left at the default, `selectTooltipAxis`
    // resolved an axis that does not exist, fell back to `implicitYAxis` (a
    // NUMBER axis with no `dataKey`), and mapped the pointer onto a two-point
    // numeric scale: only ~2 of the rows could ever become active, and the
    // tooltip confidently named the wrong day for the rest of the plot.
    //
    // The rendered-SVG proof that this actually works is in
    // `DailyBarChart.hover.test.tsx`, which moves a real pointer over every day.
    // This assertion is the configuration-level half: it fails the moment the
    // tooltip is pointed at a different axis than the bars are.
    renderChart()

    const axis = axes.find((entry) => entry.axis === 'y')
    expect(tooltips[0]).toBeDefined()
    expect(axis?.yAxisId).toBe('days')
    expect(tooltips[0]?.axisId).toBe(axis?.yAxisId)
    // Not the recharts default: the default is the value that broke hover.
    expect(tooltips[0]?.axisId).not.toBe(0)
  })
})

describe('the colour of an individual bar', () => {
  const SALES: DailyBarSeries = {
    key: 'total_sales',
    label: 'إجمالي المبيعات',
    color: 'var(--chart-bar-sales)',
    type: 'currency',
  }

  /** Runs the chart's own bar shape over one day and reads the fill it chose. */
  function fillFor(datum: DailyBarDatum, series: DailyBarSeries = EXPENSE_SERIES[0]!) {
    bars.length = 0
    renderChart({ data: [datum], series: [series] })
    const shape = bars[0]?.shape as (props: unknown) => ReactElement
    const { container } = render(
      <svg>{shape({ x: 0, y: 0, width: 40, height: 20, payload: datum, fill: 'ignored' })}</svg>,
    )
    return container.querySelector('path')?.getAttribute('fill')
  }

  it('paints a day in ITS OWN colour when the data asks for one', () => {
    expect(
      fillFor({ label: 'أ', MAINTENANCE: 1, color: 'var(--chart-bar-expenses-multiple)' }),
    ).toBe('var(--chart-bar-expenses-multiple)')
  })

  it('falls back to the series colour, so Sales never inherits another role', () => {
    // No opinion from the datum → exactly the series role, whatever it is.
    expect(fillFor({ label: 'أ', MAINTENANCE: 1 })).toBe('var(--chart-bar-primary)')
    expect(fillFor({ label: 'أ', total_sales: 1 }, SALES)).toBe('var(--chart-bar-sales)')
  })

  it('never resolves a bar to a raw colour literal', () => {
    for (const color of ['var(--chart-bar-expenses)', 'var(--chart-bar-expenses-multiple)']) {
      expect(fillFor({ label: 'أ', MAINTENANCE: 1, color })).toMatch(/^var\(--chart-bar-/)
    }
  })
})

describe('the compactness of the plot', () => {
  it('sizes the box to the number of days, so two days are a compact group', () => {
    renderChart()
    const plot = screen.getByTestId('daily-chart-plot')

    // A fixed card height is what opens the canyon between two days: recharts
    // divides whatever height it is given between the categories it is given.
    expect(plot.style.height).toBe(`min(62dvh, ${dailyPlotHeight(DATA.length)}px)`)
  })

  it('grows with the period, and never grows a scroll region', () => {
    const many: DailyBarDatum[] = Array.from({ length: 14 }, (_, index) => ({
      label: `يوم ${index}`,
      MAINTENANCE: 1_000 * (index + 1),
    }))
    renderChart({ data: many })
    const plot = screen.getByTestId('daily-chart-plot')

    expect(plot.style.height).toBe(`min(62dvh, ${dailyPlotHeight(14)}px)`)
    expect(dailyPlotHeight(14)).toBeGreaterThan(dailyPlotHeight(DATA.length))
    // No scroll region, no crop, and no CSS trick: the box is the right size and
    // recharts lays the bands out inside it.
    expect(plot.className).not.toMatch(/overflow|max-h-|scale/)
    // The band gap is a small PROPORTION of the band, and it must reach recharts
    // AS a percent string: handed a bare number it is read as pixels, which
    // subtracts a fixed amount from every band and erases the compact ones.
    expect(plots[0]?.barCategoryGap).toBe(dailyBarCategoryGap)
    expect(parseFloat(String(plots[0]?.barCategoryGap))).toBeGreaterThan(0)
    expect(parseFloat(String(plots[0]?.barCategoryGap))).toBeLessThanOrEqual(30)
  })
})

describe('the peak day', () => {
  it('states أعلى يوم, the day AND the figure in ONE bold green unit', () => {
    renderChart()
    const peak = screen.getByTestId('daily-chart-peak')

    // One highlighted unit, not a bold heading followed by muted detail: the day
    // and the figure are the same fact as the label, so they share its weight and
    // its colour. The green is the centralized `success` token — never a literal,
    // never the Station brown.
    expect(peak).toHaveClass('font-bold', 'text-success')
    expect(peak.className).not.toContain('text-primary')
    for (const part of within(peak).getAllByText(/./)) {
      expect(part.className).not.toMatch(/text-foreground-muted/)
    }
    expect(peak.textContent).toContain('أعلى يوم')
    expect(peak.textContent).toContain('٢٤ سبتمبر ٢٠٢٦')
    expect(peak.textContent).toContain('8,500.00')
  })

  it('states it ONCE, and only when there is a day to name', () => {
    renderChart()
    expect(screen.getAllByTestId('daily-chart-peak')).toHaveLength(1)

    // A period of zeroes has no peak day, and naming one would be a measurement
    // nobody made.
    renderChart({ data: [{ label: 'أ', fullLabel: 'أ ٢٠٢٦', MAINTENANCE: 0 }] })
    expect(screen.getAllByTestId('daily-chart-peak')).toHaveLength(1)
  })

  it('carries the peak into fullscreen, like every other toolbar reading', async () => {
    renderChart()
    fireEvent.click(screen.getByRole('button', { name: /تكبير الرسم البياني/ }))
    const dialog = within(await screen.findByRole('dialog'))

    expect(dialog.getByTestId('daily-chart-peak')).toBeInTheDocument()
  })
})

describe('the daily chart on the page', () => {
  it('states its title, and names the days of the period in Arabic', () => {
    renderChart()

    expect(screen.getByRole('heading', { name: 'المصروفات عبر الأيام' })).toBeInTheDocument()
    // The summary names the PEAK DAY, read from the data, in the app's Arabic
    // date form. A raw `YYYY-MM-DD` is never what a reader is shown.
    const summary = document.querySelector('.sr-only')?.textContent ?? ''
    expect(summary).toContain('٢٤ سبتمبر ٢٠٢٦')
    expect(summary).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('publishes each series colour as a chart role variable, so Dev Settings rules', () => {
    renderChart()

    // The container carries the same `--color-<key>` contract the monthly chart
    // publishes, so a bar is painted through the centralized token and never a
    // literal colour written into the component.
    const container = document.querySelector('[data-chart="container"]') as HTMLElement
    const style = container.getAttribute('style') ?? ''
    expect(style).toContain('--color-MAINTENANCE: var(--chart-bar-primary)')
    expect(style).toContain('--color-ELECTRICITY: var(--chart-bar-secondary)')
  })

  it('carries the period total in its accessible summary', () => {
    renderChart({ showTotal: true })

    // 8,500.00 + 1,200.00 + 3,000.00 + 900.00 — read from the data, not a stated
    // constant, and printed by the shared money formatter.
    expect(document.querySelector('.sr-only')?.textContent).toContain('13,600.00')
  })

  it('renders an empty period without fabricating a zero bar', () => {
    renderChart({ data: [] })

    // The card is still there with its heading and its plot frame; there is simply
    // no data behind it, and no invented measurement.
    expect(screen.getByRole('heading', { name: 'المصروفات عبر الأيام' })).toBeInTheDocument()
    expect(screen.getByTestId('daily-chart-plot')).toBeInTheDocument()
  })

  it('lays the plot out without any internal scroll region', () => {
    renderChart()
    const plot = screen.getByTestId('daily-chart-plot')

    // A long period thins its ticks rather than growing a scroll area; only the
    // fullscreen DIALOG is ever allowed to scroll.
    expect(plot.className).not.toMatch(/overflow/)
    expect(plot.className).not.toMatch(/max-h-/)
  })
})

describe('the shared fullscreen and export machinery', () => {
  it('opens, closes and restores focus, exactly as the reports charts do', async () => {
    renderChart()
    const trigger = screen.getByRole('button', { name: /تكبير الرسم البياني/ })
    trigger.focus()

    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'تكبير الرسم البياني' })
    // The SAME chart re-rendered at the fullscreen size, not a second copy.
    expect(within(dialog).getByTestId('fullscreen-daily-chart-daily')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('gives the plot a definite fullscreen height, so it cannot collapse', async () => {
    renderChart()
    fireEvent.click(screen.getByRole('button', { name: /تكبير الرسم البياني/ }))
    const dialog = within(await screen.findByRole('dialog'))

    const plot = dialog.getByTestId('daily-chart-plot')
    expect(plot.className).toMatch(/shrink-0/)
    // A compact card must not become a tiny fullscreen plot: the dialog sizes
    // itself against the VIEWPORT, and each day gets a taller band because there
    // is room for one — so fullscreen is roomier, never merely the same.
    expect(plot.style.height).toMatch(/dvh/)
    expect(plot.style.height).toContain(`${dailyPlotHeight(DATA.length, 'fullscreen')}px`)
    expect(dailyPlotHeight(DATA.length, 'fullscreen')).toBeGreaterThan(dailyPlotHeight(DATA.length))
  })

  it('calls the exporters the caller supplied, from the shared actions menu', () => {
    const onExportPng = vi.fn()
    const onExportExcel = vi.fn()
    renderChart({ onExportPng, onExportExcel })

    fireEvent.click(screen.getByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /تصدير كصورة PNG/ }))
    expect(onExportPng).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /تصدير Excel/ }))
    expect(onExportExcel).toHaveBeenCalledTimes(1)
  })

  it('renders no actions menu at all when the chart exports nothing', () => {
    renderChart()

    expect(screen.queryByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' })).toBeNull()
  })
})

describe('what the tooltip prints for a hovered day', () => {
  /** Renders the tooltip the chart itself configured, as if a day were hovered. */
  function hover(datum: DailyBarDatum, props: Partial<ChartProps> = {}) {
    renderChart(props)
    const content = tooltips[tooltips.length - 1]
    expect(content).toBeDefined()
    const { container } = render(
      <ChartTooltipContent
        {...(content!.props as Record<string, unknown>)}
        active
        payload={EXPENSE_SERIES.map((s) => ({
          dataKey: s.key,
          name: s.key,
          value: datum[s.key] as number,
          color: s.color,
          payload: datum,
        }))}
        label={datum.label}
      />,
    )
    return { tooltip: within(container as HTMLElement), container }
  }

  it('states each Arabic name in bold, the amount, and the day', () => {
    const { tooltip } = hover(DATA[0]!)

    // The heading is the DAY, read from the datum's own full label, and it says
    // what it is in the app's own words.
    expect(tooltip.getByText('التاريخ')).toBeInTheDocument()
    expect(tooltip.getByText('٢٤ سبتمبر ٢٠٢٦')).toBeInTheDocument()
    // The names are Arabic and BOLD — the manager is looking for the category.
    expect(tooltip.getByText('صيانة')).toHaveClass('font-bold')
    expect(tooltip.getByText('كهرباء')).toHaveClass('font-bold')
    // 850,000 piastres is 8,500 pounds, through the shared money formatter.
    expect(tooltip.getByText(`8,500.00 ${CURRENCY_LABEL}`)).toBeInTheDocument()
    expect(tooltip.getByText(`1,200.00 ${CURRENCY_LABEL}`)).toBeInTheDocument()
  })

  it('reveals the day’s other real readings: the count, then the average', () => {
    const { tooltip } = hover(DATA[0]!)

    // Hierarchy: the day, then the plotted measure, then the count, then the
    // average — the order a manager reads the day in. Nothing here is invented:
    // both are the backend's own reading of THIS day.
    expect(tooltip.getByText('عدد الفواتير')).toBeInTheDocument()
    expect(tooltip.getByText('متوسط قيمة الفاتورة')).toBeInTheDocument()
    expect(tooltip.getByText(`202.38 ${CURRENCY_LABEL}`)).toBeInTheDocument()
  })

  it('REGRESSION: never prints a count as money', () => {
    const { tooltip } = hover(DATA[0]!)

    // The exact fault this chart had: `عدد الفواتير 0.04 ج.م`. A count is a whole
    // number of things, so the row is `42` — and the currency label appears
    // nowhere in it.
    // The count row itself: its own text carries the figure and nothing else, so
    // the currency label of the average beside it cannot be mistaken for it.
    const countRow = tooltip.getByText('عدد الفواتير').parentElement
    expect(countRow?.textContent).toBe('عدد الفواتير42')
    // And the money rows still carry theirs, so the fix is not "never print money".
    expect(tooltip.getByText(`8,500.00 ${CURRENCY_LABEL}`)).toBeInTheDocument()
  })

  it('prints no row at all for a metric the day does not carry', () => {
    // A day with no invoices has no average ticket: printing `0.00 ج.م` would
    // state a measurement nobody made, so the row is simply absent.
    const { tooltip } = hover({ label: 'أ', fullLabel: 'أ ٢٠٢٦', MAINTENANCE: 0, invoices: 0 })

    expect(tooltip.getByText('عدد الفواتير')).toBeInTheDocument()
    expect(tooltip.queryByText('متوسط قيمة الفاتورة')).toBeNull()
  })

  it('never pairs an English series key with its Arabic name', () => {
    const { container } = hover(DATA[0]!)

    // "Maintenance صيانة" is the exact regression this contract exists to catch.
    expect(container.textContent).not.toMatch(/MAINTENANCE|ELECTRICITY|invoices|average/)
    expect(container.textContent).not.toMatch(/Maintenance|Electricity/)
  })

  it('states the hovered day total only when the caller asked for one', () => {
    const off = hover(DATA[0]!)
    expect(off.tooltip.queryByText('الإجمالي')).toBeNull()
    off.container.remove()

    const on = hover(DATA[0]!, { showTotal: true })
    expect(on.tooltip.getByText('الإجمالي')).toBeInTheDocument()
    // 8,500.00 + 1,200.00 — the day's two measures, added because this chart's
    // series really do compose one figure.
    expect(on.tooltip.getByText(`9,700.00 ${CURRENCY_LABEL}`)).toBeInTheDocument()
  })
})
