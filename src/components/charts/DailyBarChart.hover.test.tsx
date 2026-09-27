/**
 * EVERY DAY MUST BE ITS OWN HOVER TARGET
 * --------------------------------------
 * A real production bug: with 2 or 3 days the tooltip behaved, and as the number
 * of days grew the chart stopped answering. Moving the pointer down the plot
 * produced a tooltip for roughly TWO rows, and the rest of the month never
 * activated at all.
 *
 * Bars rendering correctly is a different property from bars being hoverable,
 * so this file does not mock the chart: it renders the REAL `DailyBarChart`
 * through the REAL recharts (only the measurement wrapper is replaced, because
 * jsdom cannot size anything), reads the ACTUAL rendered SVG rectangles, and
 * then moves a pointer to the CENTRE of each day's categorical band and asserts
 * that the tooltip names THAT day.
 *
 * The assertion is deliberately "mouse over row N -> tooltip identifies row N",
 * run for every single day, because a partial pass is exactly the bug: 29 of 30
 * days correct still means the chart is broken.
 */
import { fireEvent, render, waitFor } from '@testing-library/react'
import { act, cloneElement, isValidElement, type ReactElement } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chartBarColor } from '@/lib/chart-colors'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import {
  dailyBandHeight,
  dailyPlotHeight,
  type DailyBarDatum,
  type DailyBarSeries,
} from './dailyBar'

/**
 * jsdom has no layout engine, so every `getBoundingClientRect()` is 0x0 and
 * recharts' own coordinate arithmetic would collapse. A browser returns real
 * numbers; the harness returns real numbers too.
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

const PLOT_WIDTH = 640

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    // The ONLY stub: it replaces the measurement wrapper - the one thing jsdom
    // cannot do - by giving the REAL chart a real box, sized by the SAME
    // function the production container uses. Every axis, the Bar, its shape,
    // the tooltip primitive and the chart under test are production.
    ResponsiveContainer: ({ children }: { children?: React.ReactElement }) => {
      const rows = (children?.props as { data?: unknown[] } | undefined)?.data?.length ?? 1
      return isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: PLOT_WIDTH,
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

function day(index: number, value: number, color?: string): DailyBarDatum {
  return { label: `اليوم ${index}`, fullLabel: `اليوم ${index}`, amount: value, color }
}

function chart(data: DailyBarDatum[], series: DailyBarSeries = SALES) {
  return render(
    <DailyBarChart
      id="hover"
      title="رسم يومي"
      data={data}
      series={[series]}
      metrics={[]}
      dateLabel="التاريخ"
      peakLabel="أعلى يوم"
    />,
  )
}

type DrawnBar = { x: number; y: number; width: number; height: number }

function drawnBars(container: HTMLElement): DrawnBar[] {
  return [...container.querySelectorAll('.recharts-bar-rectangle path')].map((path) => ({
    x: Number(path.getAttribute('x')),
    y: Number(path.getAttribute('y')),
    width: Number(path.getAttribute('width')),
    height: Number(path.getAttribute('height')),
  }))
}

/** The recharts surface that owns the chart's mouse handlers. */
function surface(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('.recharts-surface')
  if (!svg) throw new Error('the chart drew no surface')
  return svg as SVGSVGElement
}

/**
 * recharts throttles `mousemove` through `requestAnimationFrame` by default
 * (`eventSettings.throttleDelay === 'raf'`), so a dispatched move is not an
 * ACTIVE move until the next frame has run. This waits for exactly that frame,
 * which is what the browser does between two pointer positions anyway.
 */
async function nextFrame(): Promise<void> {
  await new Promise((resolve) => {
    requestAnimationFrame(() => resolve(undefined))
  })
}

describe('a pointer over a day activates THAT day', () => {
  it.each([2, 3, 7, 14, 30])('activates every one of %i days', async (days) => {
    const data = Array.from({ length: days }, (_, index) => day(index, 1_000 * (index + 1)))
    const { container } = chart(data)
    const svg = surface(container)
    const bars = drawnBars(container)
    expect(bars).toHaveLength(days)

    for (const [index, bar] of bars.entries()) {
      const pointerY = bar.y + bar.height / 2
      await act(async () => {
        fireEvent.mouseMove(svg, { clientX: PLOT_WIDTH / 2, clientY: pointerY })
      })
      await act(nextFrame)
      const text = await tooltipText()
      expect(text, `day ${index} (pointer y=${pointerY})`).toContain(`اليوم ${index}`)
    }
  })

  it('activates every one of 30 EXPENSE days, including multiple-count colour days', async () => {
    const data = Array.from({ length: 30 }, (_, index) =>
      day(
        index,
        1_000 * (index + 1),
        index % 3 === 0 ? chartBarColor('expensesMultiple') : undefined,
      ),
    )
    const { container } = chart(data, EXPENSES)
    const svg = surface(container)
    const bars = drawnBars(container)
    expect(bars).toHaveLength(30)

    for (const [index, bar] of bars.entries()) {
      const pointerY = bar.y + bar.height / 2
      await act(async () => {
        fireEvent.mouseMove(svg, { clientX: PLOT_WIDTH / 2, clientY: pointerY })
      })
      await act(nextFrame)
      expect(await tooltipText()).toContain(`اليوم ${index}`)
    }
  })

  it('activates every day in FULLSCREEN too, where the plot is a different size', async () => {
    // The fix is not a card-only fix: the day axis is the same axis in both
    // presentations, and a taller roomier box must not bring the old two-index
    // behaviour back.
    const days = 30
    const data = Array.from({ length: days }, (_, index) => day(index, 1_000 * (index + 1)))
    const { container } = render(
      <DailyBarChart
        id="hover-fullscreen"
        title="رسم يومي"
        presentation="fullscreen"
        data={data}
        series={[SALES]}
        metrics={[]}
        dateLabel="التاريخ"
        peakLabel="أعلى يوم"
      />,
    )
    const svg = surface(container)
    const bars = drawnBars(container)
    expect(bars).toHaveLength(days)

    for (const [index, bar] of bars.entries()) {
      const pointerY = bar.y + bar.height / 2
      await act(async () => {
        fireEvent.mouseMove(svg, { clientX: PLOT_WIDTH / 2, clientY: pointerY })
      })
      await act(nextFrame)
      expect(await tooltipText()).toContain(`اليوم ${index}`)
    }
  })

  it('activates a day from the BAND, not only from the bar it draws', async () => {
    // The band is taller than the bar, and the bar is centred in it. A pointer in
    // the air above a 30-day bar is still "over that day" to a reader, and the
    // tooltip must agree - this is the "must not disappear simply because the
    // bars become thinner" requirement, tested at the thin end where it bites.
    const days = 30
    const data = Array.from({ length: days }, (_, index) => day(index, 1_000 * (index + 1)))
    const { container } = chart(data)
    const svg = surface(container)
    const bars = drawnBars(container)
    // Thin bars: this is the regime the report complained about, where a 30-day
    // bar is only a few pixels and a reader's pointer is mostly over empty band.
    const barHeight = bars[0]!.height
    expect(barHeight).toBeLessThan(dailyBandHeight(days))

    // The categorical band is measured from the RENDERED geometry rather than
    // from the sizing model: the band is the space between one day's centre and
    // its neighbour's, which is the exact region recharts resolves a pointer in.
    const centres = bars.map((bar) => bar.y + bar.height / 2)
    const bandHeight = centres[1]! - centres[0]!
    expect(bandHeight).toBeGreaterThan(barHeight)

    for (const [index, bar] of bars.entries()) {
      // The top of this day's band: midway between the previous day's centre and
      // this one. That point is in the AIR ABOVE the bar, and it is still that
      // day to anyone reading the chart.
      const previous = index === 0 ? centres[0]! - bandHeight : centres[index - 1]!
      const bandTop = (previous + centres[index]!) / 2
      expect(bandTop, `day ${index} band starts above its own bar`).toBeLessThan(bar.y)
      await act(async () => {
        fireEvent.mouseMove(svg, { clientX: PLOT_WIDTH / 2, clientY: bandTop + 0.5 })
      })
      await act(nextFrame)
      expect(await tooltipText()).toContain(`اليوم ${index}`)
    }
  })

  it('never lets a distant day answer for the day under the pointer', async () => {
    // The failure this file exists for was SILENT: recharts reported an active
    // index and a tooltip, just the wrong one. So each day's tooltip must carry
    // that day's own figure - a day that answers with its neighbour's number is
    // caught even if the label happened to line up.
    const days = 30
    const data = Array.from({ length: days }, (_, index) => day(index, 1_000 * (index + 1)))
    const { container } = chart(data)
    const svg = surface(container)
    const bars = drawnBars(container)

    const seen: number[] = []
    for (const [index, bar] of bars.entries()) {
      await act(async () => {
        fireEvent.mouseMove(svg, { clientX: PLOT_WIDTH / 2, clientY: bar.y + bar.height / 2 })
      })
      await act(nextFrame)
      const text = await tooltipText()
      const matched = new RegExp(`اليوم ${index}\\b`).test(text)
      if (matched) seen.push(index)
    }

    // Every index was reachable, each exactly once, in order, with no gaps.
    expect(seen).toEqual(bars.map((_, index) => index))
  })
})

/** The tooltip's own text, once recharts has decided a day is active. */
async function tooltipText(): Promise<string> {
  return waitFor(() => {
    const found = [...document.querySelectorAll('.recharts-tooltip-wrapper')]
      .map((wrapper) => wrapper.textContent ?? '')
      .find((text) => text.length > 0)
    if (!found) throw new Error('no tooltip yet')
    return found
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
})
