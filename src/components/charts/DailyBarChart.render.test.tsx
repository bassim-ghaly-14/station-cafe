/**
 * WHAT THE BARS ACTUALLY LOOK LIKE ON SCREEN
 * ------------------------------------------
 * The rest of this file asserts the chart's CONFIGURATION — the layout, the
 * axes, the sizing, the tooltip. This file asserts the thing a reader sees: the
 * SVG that comes out the other end.
 *
 * It exists because of a real production bug. The bars declared
 * `xAxisId="value"` / `yAxisId="days"` while the axes named themselves only with
 * `id`. recharts binds a bar to its axes by `xAxisId`/`yAxisId` and treats `id` as
 * a DOM id only, so the bar was bound to NO axis at all: recharts handed it a
 * degenerate band scale, the rectangles collapsed onto the edges of the plot at
 * 11px, and a five-day period showed exactly one visible bar. Every
 * configuration-level test in this suite still passed, because the configuration
 * was internally consistent — it was simply pointing at axes that were not
 * there.
 *
 * So this suite renders the REAL component through the REAL recharts, with only
 * the measurement wrapper replaced (jsdom cannot size anything), and counts
 * rectangles. A test that cannot see a bar missing cannot protect anyone from a
 * bar going missing.
 */
import { render } from '@testing-library/react'
import { act, cloneElement, isValidElement, type ReactElement } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chartBarColor } from '@/lib/chart-colors'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { dailyPlotHeight, type DailyBarDatum, type DailyBarSeries } from './dailyBar'

/**
 * jsdom has no layout: every `getBoundingClientRect()` is 0×0, which collapses
 * recharts' own band-scale arithmetic and would make this suite report bars as
 * broken when the chart is not. A browser returns real numbers, so the harness
 * returns real numbers too — one measurement per character stands in for a
 * font; it is not a claim about one.
 */
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function measured(this: Element) {
    const text = this.textContent ?? ''
    const width = text.length === 0 ? 640 : Math.max(6, text.length * 7)
    return {
      width,
      height: 16,
      top: 0,
      left: 0,
      right: width,
      bottom: 16,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    // The ONLY stub in this file. It replaces the measurement wrapper — the one
    // thing jsdom cannot do — by giving the REAL chart a real box. Every axis,
    // the Bar, its shape, the tooltip and the fill are production.
    //
    // The box is the one the chart SIZES ITSELF with, not a constant: a 30-day
    // period really is drawn in a taller box than a 3-day one, and a harness that
    // fixed the height would be testing a chart that does not exist.
    ResponsiveContainer: ({ children }: { children?: React.ReactElement }) => {
      const rows = (children?.props as { data?: unknown[] } | undefined)?.data?.length ?? 1
      return isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: 640,
            height: dailyPlotHeight(rows),
          })
        : null
    },
  }
})

const { DailyBarChart } = await import('./DailyBarChart')

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

const SALES: DailyBarSeries = {
  key: 'amount',
  label: 'إجمالي المبيعات',
  color: chartBarColor('sales'),
  type: 'currency',
}
const EXPENSES: DailyBarSeries = {
  key: 'amount',
  label: 'إجمالي المصروفات',
  color: chartBarColor('expenses'),
  type: 'currency',
}

/** One expense day: the amount, and the count the backend really recorded. */
function expenseDay(index: number, value: number, count: number): DailyBarDatum {
  return {
    label: `اليوم ${index}`,
    fullLabel: `اليوم ${index}`,
    amount: value,
    count,
    // Decided by the ADAPTER, exactly as `ExpensesDailyChart` decides it.
    color: count > 1 ? chartBarColor('expensesMultiple') : undefined,
  }
}

/** A Sales day. No colour of its own: the series role is the only one. */
function salesDay(index: number, value: number): DailyBarDatum {
  return { label: `اليوم ${index}`, fullLabel: `اليوم ${index}`, amount: value }
}

function chart(data: DailyBarDatum[], series: DailyBarSeries) {
  return render(
    <DailyBarChart
      id="render"
      title="رسم يومي"
      data={data}
      series={[series]}
      metrics={[]}
      dateLabel="التاريخ"
      peakLabel="أعلى يوم"
    />,
  )
}

/** Everything recharts actually drew for one bar, as numbers. */
type DrawnBar = { x: number; y: number; width: number; height: number; fill: string | null }

function drawnBars(container: HTMLElement): DrawnBar[] {
  return [...container.querySelectorAll('.recharts-bar-rectangle path')].map((path) => ({
    x: Number(path.getAttribute('x')),
    y: Number(path.getAttribute('y')),
    width: Number(path.getAttribute('width')),
    height: Number(path.getAttribute('height')),
    fill: path.getAttribute('fill'),
  }))
}

/** The assertions a reader would make with their eyes, for one bar. */
function expectVisible(bar: DrawnBar) {
  expect(Number.isFinite(bar.x), 'x is a real number').toBe(true)
  expect(Number.isFinite(bar.y), 'y is a real number').toBe(true)
  expect(bar.width, 'the bar has real length').toBeGreaterThan(0)
  expect(bar.height, 'the bar has real thickness').toBeGreaterThan(0)
  expect(bar.fill, 'the bar is painted with something').toBeTruthy()
  expect(bar.fill).not.toBe('none')
  expect(bar.fill).not.toBe('transparent')
  expect(bar.fill).not.toMatch(/rgba\([^)]*,\s*0\s*\)/)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('EVERY data row produces a VISIBLE bar', () => {
  it.each([2, 3, 5, 7, 14, 30])('draws %i Sales bars, one per day', (days) => {
    const data = Array.from({ length: days }, (_, index) => salesDay(index, 1_000 * (index + 1)))
    const { container } = chart(data, SALES)

    const bars = drawnBars(container)
    // THE regression this file exists for: N rows must be N marks, not one.
    expect(bars).toHaveLength(days)
    for (const bar of bars) expectVisible(bar)
  })

  it.each([2, 3, 5, 7, 14, 30])('draws %i Expenses bars, one per day', (days) => {
    const data = Array.from({ length: days }, (_, index) =>
      expenseDay(index, 1_000 * (index + 1), 1),
    )
    const { container } = chart(data, EXPENSES)

    const bars = drawnBars(container)
    expect(bars).toHaveLength(days)
    for (const bar of bars) expectVisible(bar)
  })

  it('stacks the days as separate ROWS, never on top of each other', () => {
    // Bars sharing a band is what "only one bar is visible" looks like from the
    // outside: they are all drawn, but on top of one another.
    const { container } = chart(
      [salesDay(0, 1_000), salesDay(1, 2_000), salesDay(2, 1_500), salesDay(3, 3_000)],
      SALES,
    )

    const rows = drawnBars(container).map((bar) => bar.y)
    expect(new Set(rows).size).toBe(rows.length)
  })

  it('gives every bar a thickness the reader can actually see', () => {
    const { container } = chart([salesDay(0, 1_000), salesDay(1, 2_000)], SALES)

    for (const bar of drawnBars(container)) {
      expect(bar.height).toBeGreaterThanOrEqual(8)
    }
  })

  it('never drops a real day to make the chart look tidy', () => {
    // A day with no spend is still a day: it is drawn at zero length, and no
    // other day's bar is dropped in its place.
    const { container } = chart(
      [expenseDay(0, 1_000, 1), expenseDay(1, 0, 0), expenseDay(2, 3_000, 2)],
      EXPENSES,
    )

    expect(drawnBars(container).length).toBeGreaterThanOrEqual(2)
  })
})

describe('the colour each bar is actually painted with', () => {
  it('paints every Sales bar with the Sales role, and no bar disappears', () => {
    // The exact fault: a chart where only the first bar resolves its fill and the
    // rest go transparent. Four rows, four visible bars, one colour.
    const { container } = chart(
      [salesDay(0, 1_000), salesDay(1, 2_000), salesDay(2, 1_500), salesDay(3, 3_000)],
      SALES,
    )

    const bars = drawnBars(container)
    expect(bars).toHaveLength(4)
    for (const bar of bars) {
      expectVisible(bar)
      expect(bar.fill).toBe(chartBarColor('sales'))
    }
  })

  it('paints a day of 1 expense normally and 2+ expenses with the companion role', () => {
    // 1 → expenses, 2 → expensesMultiple, 1 → expenses, 3 → expensesMultiple.
    // ALL FOUR VISIBLE: a colour distinction that costs a bar is not a
    // distinction, it is a bug.
    const { container } = chart(
      [
        expenseDay(0, 1_000, 1),
        expenseDay(1, 2_000, 2),
        expenseDay(2, 1_500, 1),
        expenseDay(3, 3_000, 3),
      ],
      EXPENSES,
    )

    const bars = drawnBars(container)
    expect(bars).toHaveLength(4)
    expect(bars.map((bar) => bar.fill)).toEqual([
      chartBarColor('expenses'),
      chartBarColor('expensesMultiple'),
      chartBarColor('expenses'),
      chartBarColor('expensesMultiple'),
    ])
    for (const bar of bars) expectVisible(bar)
  })

  it('resolves only to centralized roles — never a literal, never a fallback', () => {
    const { container } = chart([expenseDay(0, 1_000, 1), expenseDay(1, 2_000, 9)], EXPENSES)

    for (const bar of drawnBars(container)) {
      expect(bar.fill).toMatch(/^var\(--chart-bar-[a-z-]+\)$/)
    }
  })

  it('lets two different colours coexist on neighbouring bars', () => {
    // Alternating fills is the hardest case for a renderer: a shared fill, a
    // shared key or an index mismatch shows up here as one colour repeated.
    const { container } = chart(
      [
        expenseDay(0, 1_000, 1),
        expenseDay(1, 2_000, 2),
        expenseDay(2, 1_500, 1),
        expenseDay(3, 3_000, 2),
      ],
      EXPENSES,
    )

    const fills = drawnBars(container).map((bar) => bar.fill)
    expect(new Set(fills).size).toBe(2)
  })
})

describe('the peak day, as it is read', () => {
  function peak() {
    const { getByTestId } = chart(
      [expenseDay(0, 1_000, 1), expenseDay(1, 850_000, 1), expenseDay(2, 3_000, 1)],
      EXPENSES,
    )
    return getByTestId('daily-chart-peak')
  }

  it('states the label, the day AND the figure in ONE bold hand', () => {
    const badge = peak()

    // One unit, one weight: a bold heading followed by muted detail is exactly
    // the hierarchy this had, and it is wrong — the day and the figure are the
    // same fact as the label, not supporting metadata.
    expect(badge.className).toContain('font-bold')
    for (const part of badge.querySelectorAll('span')) {
      expect(part.className).not.toMatch(/text-foreground-muted/)
    }
    expect(badge.textContent).toContain('أعلى يوم')
    expect(badge.textContent).toMatch(/اليوم 1/)
    expect(badge.textContent).toMatch(/8,500\.00/)
  })

  it('is GREEN, from the centralized token — never brown, never a literal', () => {
    const badge = peak()

    expect(badge.className).toContain('text-success')
    expect(badge.className).not.toContain('text-primary')
    expect(badge.className).not.toContain('text-destructive')
    // `text-success` is a theme utility, so the colour itself stays the token's
    // decision and no hex is written into the chart.
    expect(badge.className).not.toMatch(/#[0-9a-f]{3,6}|rgb/)
  })

  it('keeps the bar colours untouched by the green summary', () => {
    // The peak is a UI summary. It must not repaint a single bar.
    const { container, getByTestId } = chart(
      [expenseDay(0, 1_000, 1), expenseDay(1, 850_000, 1)],
      EXPENSES,
    )

    expect(getByTestId('daily-chart-peak').className).toContain('text-success')
    for (const bar of drawnBars(container)) {
      expect(bar.fill).toBe(chartBarColor('expenses'))
    }
  })
})

describe('the day label on screen', () => {
  it('prints the whole Arabic date on ONE line', () => {
    const date = 'السبت، ٢٧ سبتمبر ٢٠٢٦'
    const { container } = render(
      <DailyBarChart
        id="one-line"
        title="رسم يومي"
        data={[{ label: date, fullLabel: date, amount: 1_000 }, salesDay(1, 2_000)]}
        series={[SALES]}
        metrics={[]}
        dateLabel="التاريخ"
        peakLabel="أعلى يوم"
      />,
    )

    const labels = [...container.querySelectorAll('.recharts-cartesian-axis-tick-value')]
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      // A wrapped date is two `<tspan>` lines inside one `<text>`.
      expect(label.querySelectorAll('tspan')).toHaveLength(1)
      expect(label.textContent).not.toMatch(/…|\.\.\./)
    }
    expect(labels.map((label) => label.textContent)).toContain(date)
  })
})
