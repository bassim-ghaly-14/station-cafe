/**
 * The pure daily model, tested without rendering anything.
 *
 * These are the decisions the chart cannot be trusted to make for itself: what a
 * day's value is, what a period totals, which day is the peak, and — the one that
 * actually decides whether the chart is readable — whether the bars may carry
 * printed values at all.
 */
import { describe, expect, it } from 'vitest'
import {
  DAILY_BAR_CATEGORY_GAP,
  DAILY_BAR_MAX_SIZE,
  DAILY_DAY_AXIS_WIDTH,
  DAILY_PLOT_RANGE,
  DAILY_ROW_HEIGHT,
  MAX_LABELLED_DAYS,
  canLabelBars,
  dailyBandHeight,
  dailyBarFill,
  dailyBarSize,
  dailyMetricValue,
  dailyPlotHeight,
  dailyValue,
  dayTotal,
  peakDay,
  seriesTotal,
  type DailyBarSeries,
} from './dailyBar'

const SERIES: DailyBarSeries[] = [
  { key: 'cafe', label: 'كافيه', color: 'var(--info)', type: 'currency' },
  { key: 'wash', label: 'مغسلة', color: 'var(--primary)', type: 'currency' },
]

function day(label: string, cafe: string | number | undefined, wash?: string | number) {
  return { label, fullLabel: `${label} ٢٠٢٦`, cafe, wash }
}

describe('reading a day', () => {
  it('reads a number, and treats a missing or unparseable value as zero', () => {
    expect(dailyValue(day('أ', 100), 'cafe')).toBe(100)
    expect(dailyValue(day('أ', '250'), 'cafe')).toBe(250)
    expect(dailyValue(day('أ', undefined), 'cafe')).toBe(0)
    expect(dailyValue(day('أ', 'not a number'), 'cafe')).toBe(0)
  })

  it('totals the day across every configured series', () => {
    expect(dayTotal(day('أ', 100, 50), SERIES)).toBe(150)
    // A category the day never touched is a real zero, not a hole.
    expect(dayTotal(day('أ', 100), SERIES)).toBe(100)
  })

  it('totals a series across the whole period', () => {
    const data = [day('أ', 100, 50), day('ب', 200, 25)]
    expect(seriesTotal(data, 'cafe')).toBe(300)
    expect(seriesTotal(data, 'wash')).toBe(75)
  })

  it('finds the peak day, and reports nothing for an empty period', () => {
    const data = [day('أ', 100), day('ب', 900), day('ج', 300)]
    expect(peakDay(data, 'cafe')?.datum.label).toBe('ب')
    expect(peakDay(data, 'cafe')?.value).toBe(900)
    expect(peakDay([], 'cafe')).toBeNull()
  })
})

describe('when the bars may carry printed values', () => {
  it('prints them for an ordinary period, up to a month of days', () => {
    expect(canLabelBars(1)).toBe(true)
    expect(canLabelBars(7)).toBe(true)
    expect(canLabelBars(MAX_LABELLED_DAYS)).toBe(true)
  })

  it('stops printing them once they would collide, rather than smearing them', () => {
    // A quarter of daily bars cannot each carry a money figure legibly. The bar
    // height, the axis and the tooltip still state the value, so nothing is lost.
    expect(canLabelBars(MAX_LABELLED_DAYS + 1)).toBe(false)
    expect(canLabelBars(90)).toBe(false)
  })

  it('prints nothing for a period with no days at all', () => {
    expect(canLabelBars(0)).toBe(false)
  })
})

describe('reading a tooltip metric', () => {
  it('reads a real reading, and tells a real zero from an absent one', () => {
    // A day with no invoices genuinely recorded `0` invoices: that IS a reading.
    expect(dailyMetricValue({ label: 'أ', invoices: 0 }, 'invoices')).toBe(0)
    // A day that does not carry the key at all has NO average: printing `0.00`
    // there would state a measurement nobody made, so the row is not printed.
    expect(dailyMetricValue({ label: 'أ' }, 'average')).toBeNull()
    expect(dailyMetricValue({ label: 'أ', average: '' }, 'average')).toBeNull()
    expect(dailyMetricValue({ label: 'أ', average: 'nonsense' }, 'average')).toBeNull()
    expect(dailyMetricValue({ label: 'أ', average: 4800 }, 'average')).toBe(4_800)
  })
})

describe('the compactness of the plot', () => {
  it('grows with the DATA, so two days are two rows and not two slabs', () => {
    // The height recharts is given is what it divides between the categories it
    // is given, so a fixed card asked for two days is what opens the canyon.
    const two = dailyPlotHeight(2)
    const five = dailyPlotHeight(5)
    const fourteen = dailyPlotHeight(14)

    expect(two).toBeLessThan(five)
    expect(five).toBeLessThan(fourteen)
    // A one-day and a two-day period are one row apart — a compact group, not a
    // card with two bars marooned in it.
    expect(dailyPlotHeight(1)).toBeLessThan(two)
  })

  it('never falls below a readable card, and never demands a scroll region', () => {
    expect(dailyPlotHeight(0)).toBe(DAILY_PLOT_RANGE.card.min)
    expect(dailyPlotHeight(1)).toBe(DAILY_PLOT_RANGE.card.min)
    // A long period is bounded: a month of days still fits the card, and a
    // quarter of them is the same bounded box with thinner rows — never taller.
    expect(dailyPlotHeight(31)).toBe(DAILY_PLOT_RANGE.card.max)
    expect(dailyPlotHeight(90)).toBe(DAILY_PLOT_RANGE.card.max)
  })

  it('gives fullscreen roomier rows, and bounds them just as tightly', () => {
    // Fullscreen is not the compact card blown up: each day is a taller band
    // because there is more of them worth filling, and the ceiling keeps the
    // dialog inside a laptop screen.
    expect(dailyPlotHeight(7, 'fullscreen')).toBeGreaterThan(dailyPlotHeight(7))
    expect(dailyPlotHeight(90, 'fullscreen')).toBe(DAILY_PLOT_RANGE.fullscreen.max)
    expect(dailyPlotHeight(1, 'fullscreen')).toBe(DAILY_PLOT_RANGE.fullscreen.min)
  })

  it('keeps the band gap small, so compact bands stay a compact group', () => {
    // Once the container is sized to the data, a large category gap would
    // re-open the canyon; this is the proportion that keeps neighbouring days
    // apart at every plot size.
    expect(DAILY_BAR_CATEGORY_GAP).toBeGreaterThan(0)
    expect(DAILY_BAR_CATEGORY_GAP).toBeLessThanOrEqual(30)
  })
})

describe('how thick a bar may be drawn', () => {
  it('is SUBSTANTIALLY thicker than the thin implementation it replaces', () => {
    // The bars this chart used to draw were capped at 22px in a card and 28px in
    // fullscreen, which read as hairlines rather than as the chart's primary
    // marks. Wherever the box has room, every period now asks for more.
    for (const days of [1, 2, 3, 5, 7, 14]) {
      expect(dailyBarSize(days)).toBeGreaterThan(22)
      expect(dailyBarSize(days, 'fullscreen')).toBeGreaterThan(28)
    }
    expect(dailyBarSize(2)).toBeGreaterThanOrEqual(28)
    expect(dailyBarSize(2, 'fullscreen')).toBeGreaterThanOrEqual(36)
  })

  it('is a real share of the ROW, and never thicker than the band it sits in', () => {
    // The relationship the whole thing hangs on: the bar fills most of the band
    // its day was given, and it can never be drawn taller than that band — a cap
    // that exceeded it would draw each bar on top of its neighbour.
    for (const days of [1, 2, 3, 7, 14, 30, 90]) {
      const size = dailyBarSize(days)
      expect(size).toBeGreaterThan(0)
      expect(size).toBeLessThanOrEqual(Math.floor(dailyBandHeight(days)))
    }
    // With room to spare, the bar really does claim most of its row.
    for (const days of [1, 2, 3, 7, 14]) {
      expect(dailyBarSize(days)).toBeGreaterThan(DAILY_ROW_HEIGHT.card * 0.5)
    }
  })

  it('responds to the period: thick for two days, thinned for a month', () => {
    // 1–3 days: noticeably thick. 4–7: still thick. 8–15: moderate. 16+: whatever
    // the space allows — the chart never enlarges a bar to fill a crowded plot.
    const two = dailyBarSize(2)
    const seven = dailyBarSize(7)
    const fourteen = dailyBarSize(14)
    const thirty = dailyBarSize(30)

    expect(two).toBeGreaterThan(seven)
    expect(seven).toBeGreaterThan(fourteen)
    expect(fourteen).toBeGreaterThan(thirty)
    // A month is still a visible bar, not a hairline.
    expect(thirty).toBeGreaterThanOrEqual(6)
    // And a quarter of them is exactly the band there is — never a bar that
    // claims more room than its own row.
    expect(dailyBarSize(90)).toBe(Math.floor(dailyBandHeight(90)))
  })

  it('gives fullscreen a taller bar than the card, and bounds both', () => {
    for (const days of [1, 2, 7, 14, 30, 90]) {
      expect(dailyBarSize(days, 'fullscreen')).toBeGreaterThan(dailyBarSize(days))
      expect(dailyBarSize(days)).toBeLessThanOrEqual(DAILY_BAR_MAX_SIZE.card)
      expect(dailyBarSize(days, 'fullscreen')).toBeLessThanOrEqual(DAILY_BAR_MAX_SIZE.fullscreen)
    }
  })

  it('treats an empty period as one day rather than dividing by nothing', () => {
    expect(dailyBarSize(0)).toBe(dailyBarSize(1))
    expect(dailyBarSize(-3)).toBe(dailyBarSize(1))
  })
})

describe('the day label', () => {
  it("is given a column wide enough for the project's whole Arabic date", () => {
    // The date is never shortened to fit: the axis is widened instead, which is
    // the only thing that actually stops recharts breaking the tick into two
    // `<tspan>` lines. Generous enough for `السبت، ٢٧ سبتمبر ٢٠٢٦`, and not so
    // wide that it steals the plot from the bars.
    expect(DAILY_DAY_AXIS_WIDTH.card).toBeGreaterThanOrEqual(140)
    expect(DAILY_DAY_AXIS_WIDTH.fullscreen).toBeGreaterThanOrEqual(DAILY_DAY_AXIS_WIDTH.card)
    expect(DAILY_DAY_AXIS_WIDTH.card).toBeLessThanOrEqual(180)
  })
})

describe('the colour one bar is painted with', () => {
  it("is the day's own colour when it has one, and the series' when it has not", () => {
    const sales: DailyBarSeries = {
      key: 'cafe',
      label: 'كافيه',
      color: 'var(--chart-bar-sales)',
      type: 'currency',
    }

    // No opinion from the datum (every Sales day) → the series role, untouched.
    expect(dailyBarFill({ label: 'أ', cafe: 1 }, sales)).toBe('var(--chart-bar-sales)')
    // A day that names a centralized role gets exactly that role, never a literal.
    expect(
      dailyBarFill({ label: 'أ', cafe: 1, color: 'var(--chart-bar-expenses-multiple)' }, sales),
    ).toBe('var(--chart-bar-expenses-multiple)')
  })
})
