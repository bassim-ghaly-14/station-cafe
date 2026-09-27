/**
 * What the chart asks RECHARTS to draw — the one thing the arithmetic tests
 * cannot see: whether the series of a month are told to stack into a single bar
 * or to stand side by side.
 *
 * recharts is real here; only its `<Bar>` is replaced by a recorder, because the
 * `stackId` is a prop, not rendered output. `ResponsiveContainer` and `BarChart`
 * are unwrapped to plain fragments because jsdom gives them no size, and a
 * zero-sized chart renders no children at all — every other recharts piece, and
 * the chart under test, is the production one.
 */
import { render } from '@testing-library/react'
import { act, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'

type BarProps = { dataKey?: string; stackId?: string; maxBarSize?: number; fill?: string }

const drawn: BarProps[] = []

/** Renders its children with no box of its own. */
const passThrough = ({ children }: { children?: ReactNode }) => <>{children}</>

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: passThrough,
    BarChart: passThrough,
    Bar: (props: BarProps) => {
      drawn.push(props)
      return null
    },
  }
})

const { MonthlyComparisonBarChart } = await import('./MonthlyComparisonBarChart')
type ChartProps = Parameters<typeof MonthlyComparisonBarChart>[0]

const SERIES = [
  { key: 'SALARY', label: 'رواتب', color: 'var(--primary)' },
  { key: 'UTILITIES', label: 'مرافق', color: 'var(--info)' },
  { key: 'SUPPLIES', label: 'مشتريات', color: 'var(--warning)' },
]

const DATA = [
  {
    month: '2026-01',
    label: 'يناير',
    fullLabel: 'يناير 2026',
    SALARY: 100,
    UTILITIES: 50,
    SUPPLIES: 25,
  },
  {
    month: '2026-02',
    label: 'فبراير',
    fullLabel: 'فبراير 2026',
    SALARY: 200,
    UTILITIES: 50,
    SUPPLIES: 25,
  },
]

function chart(props: Partial<ChartProps> = {}) {
  return render(
    <MonthlyComparisonBarChart
      id="stack-contract"
      title="المصروفات الشهرية"
      data={DATA}
      series={SERIES}
      formatValue={(value) => String(value)}
      comparisonLabel="مقارنة بالشهر السابق"
      comparisonUnavailableLabel="لا توجد مقارنة"
      {...props}
    />,
  )
}

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

describe('the bars the chart asks recharts to draw', () => {
  beforeEach(() => {
    drawn.length = 0
  })

  it('stacks EVERY category of a month into ONE bar, under one shared stack id', () => {
    chart({ layout: 'stacked', stackId: 'expenses' })

    // One bar per category, and every one of them in the same stack — that shared
    // id is exactly what turns three bars a month into one column of segments.
    expect(drawn).toHaveLength(3)
    expect(drawn.map((bar) => bar.dataKey)).toEqual(['SALARY', 'UTILITIES', 'SUPPLIES'])
    expect(new Set(drawn.map((bar) => bar.stackId)).size).toBe(1)
    expect(drawn[0].stackId).toBe('expenses')
  })

  it('paints each segment in its own category colour', () => {
    chart({ layout: 'stacked', stackId: 'expenses' })

    expect(drawn.map((bar) => bar.fill)).toEqual([
      'var(--primary)',
      'var(--info)',
      'var(--warning)',
    ])
    // Three categories, three distinct colours: a stack is unreadable if two
    // segments look alike.
    expect(new Set(drawn.map((bar) => bar.fill)).size).toBe(3)
  })

  it('draws one wider bar per month, not several slim ones', () => {
    chart({ layout: 'stacked', stackId: 'expenses' })
    const stacked = drawn.map((bar) => bar.maxBarSize)

    drawn.length = 0
    chart()
    const grouped = drawn.map((bar) => bar.maxBarSize)

    // A lone bar per month can be wider than one bar of a group, and the
    // comparison is what says the grouped chart is still slim.
    expect(stacked[0]).toBeGreaterThan(grouped[0] as number)
  })

  it('leaves the default chart with NO stack id, so grouped bars stay side by side', () => {
    chart()

    expect(drawn).toHaveLength(3)
    // The absence of a shared stackId is the whole difference: recharts then
    // places the series next to each other instead of summing them.
    expect(drawn.every((bar) => bar.stackId === undefined)).toBe(true)
  })

  it('namespaces the stack by the chart id when the caller gives no stack id', () => {
    chart({ layout: 'stacked' })

    expect(drawn).toHaveLength(3)
    expect(drawn.every((bar) => bar.stackId === 'stack-stack-contract')).toBe(true)
  })
})
