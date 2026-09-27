/**
 * The two PRESENTATION contracts the monthly chart owes its reader, in the places
 * the arithmetic tests and the stack contract cannot see: the fullscreen bounds,
 * and the total the tooltip states.
 *
 * recharts is real here, with only `<Tooltip>` and the sizing wrappers unwrapped:
 * the tooltip's `content` is a PROP, and a zero-sized chart renders no children at
 * all, so both have to be replaced to be asserted on. Every other recharts piece,
 * the real tooltip primitive and the chart under test are the production ones.
 *
 * The bounds themselves are asserted on the real production CLASSES: a bounded box
 * is a CSS contract, and jsdom computes no layout, so the class list is the only
 * honest observable — and the only one that would catch the regression.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { act, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import type { MonthlyComparisonDatum, MonthlySeriesConfig } from './monthlyComparison'

/** The tooltip content element the chart hands to recharts. */
const tooltips: ReactElement<Record<string, unknown>>[] = []

/** Renders its children with no box of its own. */
const passThrough = ({ children }: { children?: ReactNode }) => <>{children}</>

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: passThrough,
    BarChart: passThrough,
    Tooltip: (props: { content?: ReactElement<Record<string, unknown>> }) => {
      if (props.content) tooltips.push(props.content)
      return null
    },
  }
})

const { MonthlyComparisonBarChart } = await import('./MonthlyComparisonBarChart')
// The shared primitive is imported dynamically too, so the hoisted `vi.mock`
// factory above is in place before recharts is pulled in through it.
const { ChartTooltipContent } = await import('@/components/ui/chart')
type ChartProps = Parameters<typeof MonthlyComparisonBarChart>[0]

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

/** Cafe vs Wash — the monthly revenue comparison. */
const REVENUE: MonthlySeriesConfig[] = [
  { key: 'cafe', label: 'كافيه', color: 'var(--info)' },
  { key: 'wash', label: 'مغسلة', color: 'var(--primary)' },
]

const JANUARY: MonthlyComparisonDatum = {
  month: '2026-01',
  label: 'يناير',
  fullLabel: 'يناير 2026',
  cafe: 12_000,
  wash: 8_000,
}
/** A month with nothing on one side: the total is still the whole month. */
const FEBRUARY: MonthlyComparisonDatum = {
  month: '2026-02',
  label: 'فبراير',
  fullLabel: 'فبراير 2026',
  cafe: 0,
  wash: 9_000,
}

const money = (value: number) => `${value.toLocaleString('en-US')} ج.م`

function renderChart(props: Partial<ChartProps> = {}) {
  return render(
    <MonthlyComparisonBarChart
      id="presentation"
      title="الإيرادات الشهرية"
      data={[JANUARY, FEBRUARY]}
      series={REVENUE}
      formatValue={money}
      showTotal
      {...props}
    />,
  )
}

/** Opens the fullscreen dialog and returns its scope. */
async function openFullscreen() {
  fireEvent.click(screen.getByRole('button', { name: /تكبير الرسم البياني/ }))
  return within(await screen.findByRole('dialog'))
}

/** The hovered payload recharts would report for a month. */
function payloadFor(datum: MonthlyComparisonDatum) {
  return REVENUE.map((item) => ({
    dataKey: item.key,
    name: item.key,
    value: datum[item.key] as number,
    color: item.color,
    payload: datum,
  }))
}

describe('the fullscreen chart and its category area', () => {
  beforeEach(() => {
    tooltips.length = 0
  })

  it('grows with its content and gives the plot a definite height', async () => {
    renderChart()
    const dialog = await openFullscreen()
    const card = dialog.getByTestId('fullscreen-monthly-chart-presentation')
    const plot = card.querySelector('[data-testid="monthly-chart-plot"]')

    // The card is no longer a fixed slice of the viewport: it takes the height its
    // rows need, and only the DIALOG ever scrolls, which is pre-existing.
    expect(card.className).toMatch(/max-h-\[calc\(100dvh-4rem\)\]/)
    expect(card.className).not.toMatch(/overflow-hidden/)
    // The plot keeps a real, viewport-relative height: `shrink-0` stops the flex
    // column from squeezing it away, and the ABSENCE of `flex-1` stops it handing
    // its box to the grid. A collapsed plot is a chart out of view.
    expect(plot?.className).toMatch(/shrink-0/)
    expect(plot?.className).toMatch(/h-\[min\(48dvh/)
    expect(plot?.className).not.toMatch(/flex-1/)
  })

  it('lays the categories out as a wrapping responsive grid', async () => {
    renderChart()
    const dialog = await openFullscreen()
    const list = dialog
      .getByTestId('fullscreen-monthly-chart-presentation')
      .querySelector('[data-testid="monthly-chart-legend"]') as HTMLElement

    // Columns step up with the available width, so the same markup serves a phone
    // and a full desktop without a hardcoded column count.
    expect(list.className).toMatch(/grid-cols-1/)
    expect(list.className).toMatch(/sm:grid-cols-2/)
    expect(list.className).toMatch(/lg:grid-cols-3/)
    expect(list.className).toMatch(/2xl:grid-cols-4/)
  })

  it('NEVER scrolls the category area, at any category count', async () => {
    // Every count the brief calls out, from the trivial to well past a full screen.
    for (const count of [2, 4, 5, 8, 12, 20, 24]) {
      const many: MonthlySeriesConfig[] = Array.from({ length: count }, (_, index) => ({
        key: `CAT_${index}`,
        label: `فئة ${index}`,
        color: 'var(--primary)',
      }))
      const view = renderChart({ series: many })
      fireEvent.click(within(view.container).getByRole('button', { name: /تكبير الرسم البياني/ }))
      const dialog = within(
        (await screen.findByRole('dialog', { name: 'تكبير الرسم البياني' })) as HTMLElement,
      )
      const list = dialog
        .getByTestId('fullscreen-monthly-chart-presentation')
        .querySelector('[data-testid="monthly-chart-legend"]') as HTMLElement

      // No scroll container in either axis, and nothing that clips a row away.
      expect(list.className, `${count} categories`).not.toMatch(/overflow/)
      expect(list.className, `${count} categories`).not.toMatch(/max-h-/)
      // Every category is present at once — none hidden, none collapsed, none cut.
      for (const item of many) {
        expect(within(list).getByText(item.label), `${count} categories`).toBeInTheDocument()
      }
      // Each category keeps its OWN amount in the same cell, so a figure can never
      // be read against the wrong name.
      expect(within(list).getAllByText('0 ج.م')).toHaveLength(count)

      view.unmount()
      tooltips.length = 0
    }
  })

  it('does not truncate a long category name', async () => {
    const long: MonthlySeriesConfig[] = [
      {
        key: 'MAINTENANCE',
        label: 'صيانة أجهزة المطبخ وطاولات الجلوس والمكيفات',
        color: 'var(--primary)',
      },
    ]
    renderChart({ series: long })
    const dialog = await openFullscreen()
    const list = dialog
      .getByTestId('fullscreen-monthly-chart-presentation')
      .querySelector('[data-testid="monthly-chart-legend"]') as HTMLElement

    // The whole name is rendered, and it WRAPS rather than being cut with an
    // ellipsis.
    const name = within(list).getByText(long[0]!.label)
    expect(name).toBeInTheDocument()
    expect(name.className).not.toMatch(/truncate/)
    // Matched on the INTENT, not on one Tailwind version's spelling: `break-words`
    // (v3) and `wrap-break-word` (v4) are the same `overflow-wrap: break-word`
    // utility, and this suite runs against whichever the project ships. Asserting
    // a bare version-specific name here only breaks when Tailwind is upgraded,
    // which is exactly the churn this assertion exists to avoid.
    expect(name.className).toMatch(/break-word/)
  })

  it('leaves the inline card exactly as it was', () => {
    renderChart()
    const card = screen.getByTestId('monthly-chart-presentation')

    expect(card.className).toMatch(/min-h-88/)
    expect(card.className).not.toMatch(/overflow-hidden/)
  })

  it('keeps the layout intact after the viewport has already been resized', async () => {
    renderChart()
    const dialog = await openFullscreen()
    await act(async () => {
      window.innerWidth = 1024
      window.innerHeight = 768
      window.dispatchEvent(new Event('resize'))
    })

    const card = dialog.getByTestId('fullscreen-monthly-chart-presentation')
    const list = card.querySelector('[data-testid="monthly-chart-legend"]') as HTMLElement
    // Responsive to the resize: the same wrapping grid, still no scroll region.
    expect(list.className).toMatch(/grid-cols-1/)
    expect(list.className).not.toMatch(/overflow/)
  })
})

describe('the monthly total in the tooltip', () => {
  beforeEach(() => {
    tooltips.length = 0
  })

  /**
   * Renders the tooltip the chart itself configured, as if a month were hovered.
   *
   * The returned queries are SCOPED to the tooltip, because the card behind it
   * also prints the latest month's figures in its legend — an unscoped query
   * would match the same number twice and prove nothing about the tooltip.
   */
  function hover(datum: MonthlyComparisonDatum) {
    renderChart()
    const content = tooltips[tooltips.length - 1]
    expect(content).toBeDefined()
    const { container } = render(
      <ChartTooltipContent
        {...content!.props}
        active
        payload={payloadFor(datum)}
        label={datum.label}
      />,
    )
    return { tooltip: within(container as HTMLElement), container }
  }

  it('states Cafe + Wash for the hovered month, in Arabic, as a separate row', () => {
    const { tooltip, container } = hover(JANUARY)

    expect(tooltip.getByText('كافيه')).toBeInTheDocument()
    expect(tooltip.getByText('مغسلة')).toBeInTheDocument()
    expect(tooltip.getByText('12,000 ج.م')).toBeInTheDocument()
    expect(tooltip.getByText('8,000 ج.م')).toBeInTheDocument()
    // The total is its own Arabic row — "الإجمالي" — carrying the SUM of the two
    // rows above it: 12,000 + 8,000.
    expect(tooltip.getByText('الإجمالي')).toBeInTheDocument()
    expect(tooltip.getByText('20,000 ج.م')).toBeInTheDocument()
    // Arabic only: no series key and no English gloss beside the Arabic name.
    expect(container.textContent).not.toMatch(/cafe|wash|Total/i)
  })

  it('reads the total from the hovered row, so a zero side still totals correctly', () => {
    const { tooltip } = hover(FEBRUARY)

    // Cafe drew nothing that month, and the total is still the whole month:
    // the 9,000 of Wash alone, stated once as the row and once as the total.
    expect(tooltip.getByText('الإجمالي')).toBeInTheDocument()
    expect(tooltip.getAllByText('9,000 ج.م')).toHaveLength(2)
  })

  it('follows the dataset: a changed month states its own total', () => {
    const march: MonthlyComparisonDatum = {
      month: '2026-03',
      label: 'مارس',
      fullLabel: 'مارس 2026',
      cafe: 1_500,
      wash: 2_500,
    }
    renderChart({ data: [JANUARY, march] })
    const content = tooltips[tooltips.length - 1]
    render(
      <ChartTooltipContent {...content!.props} active payload={payloadFor(march)} label="مارس" />,
    )

    expect(screen.getByText('4,000 ج.م')).toBeInTheDocument()
    // February's figure is nowhere in a tooltip for March.
    expect(screen.queryByText('9,000 ج.م')).not.toBeInTheDocument()
  })

  it('says no total for a grouped chart whose caller did not ask for one', () => {
    // Cash vs Card add up to nothing, so their chart must not claim a total.
    renderChart({ showTotal: false })
    const content = tooltips[tooltips.length - 1]
    const { queryByText } = render(
      <ChartTooltipContent
        {...content!.props}
        active
        payload={payloadFor(FEBRUARY)}
        label="فبراير"
      />,
    )

    expect(queryByText('الإجمالي')).not.toBeInTheDocument()
  })
})
