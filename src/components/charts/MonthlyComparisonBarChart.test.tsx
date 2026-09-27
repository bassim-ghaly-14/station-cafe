/**
 * The chart is tested through what it SHOWS and what it CALLS — never through
 * recharts internals. The maths is covered separately in `monthlyComparison.test`;
 * this file proves the surrounding contract: the month-over-month states, the
 * reuse of the existing fullscreen dialog, and the export menu calling the
 * exporters the caller supplied.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { MonthlyComparisonBarChart } from './MonthlyComparisonBarChart'
import type { MonthlyComparisonDatum, MonthlySeriesConfig } from './monthlyComparison'

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

const SERIES: MonthlySeriesConfig[] = [
  { key: 'cash', label: 'كاش', color: 'var(--success)' },
  { key: 'visa', label: 'فيزا', color: 'var(--info)' },
]

function month(key: string, label: string, cash: number, visa: number): MonthlyComparisonDatum {
  return { month: key, label, fullLabel: label, cash, visa }
}

const DATA = [month('2026-01', 'يناير 2026', 100, 100), month('2026-02', 'فبراير 2026', 150, 100)]

function renderChart(props: Partial<Parameters<typeof MonthlyComparisonBarChart>[0]> = {}) {
  return render(
    <MonthlyComparisonBarChart
      id="test-monthly"
      title="مقارنة شهرية"
      description="وصف"
      period="الفترة: 01/01/2026 — 28/02/2026"
      data={DATA}
      series={SERIES}
      formatValue={(value) => String(value)}
      comparisonLabel="مقارنة بالشهر السابق"
      comparisonUnavailableLabel="لا توجد مقارنة بالشهر السابق"
      {...props}
    />,
  )
}

describe('MonthlyComparisonBarChart', () => {
  it('shows both series, the latest values and the title', () => {
    renderChart()

    expect(screen.getByRole('heading', { name: 'مقارنة شهرية' })).toBeInTheDocument()
    expect(screen.getByText('كاش')).toBeInTheDocument()
    expect(screen.getByText('فيزا')).toBeInTheDocument()
    // The legend doubles as the latest month's per-series value.
    expect(screen.getByText('150')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })

  it('reads the month-over-month indicator from the TOTAL of the series', () => {
    // 200 → 250 is +25% even though only one of the two series grew.
    renderChart()
    expect(screen.getByText('25.0%')).toBeInTheDocument()
    expect(screen.getByText('مقارنة بالشهر السابق')).toBeInTheDocument()
  })

  it('states that there is no comparison when only one month exists', () => {
    renderChart({ data: [month('2026-01', 'يناير 2026', 100, 100)] })

    expect(screen.queryByText('%')).not.toBeInTheDocument()
    expect(screen.getByText('لا توجد مقارنة بالشهر السابق')).toBeInTheDocument()
  })

  it('never prints a percentage when the previous month was zero', () => {
    renderChart({
      data: [month('2026-01', 'يناير 2026', 0, 0), month('2026-02', 'فبراير 2026', 500, 0)],
    })

    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument()
    expect(screen.getByText('لا توجد مقارنة بالشهر السابق')).toBeInTheDocument()
  })

  it('opens and closes the shared fullscreen dialog and restores focus', async () => {
    renderChart()
    const trigger = screen.getByRole('button', { name: /تكبير الرسم البياني/ })
    trigger.focus()

    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'تكبير الرسم البياني' })
    expect(within(dialog).getByRole('heading', { name: 'مقارنة شهرية' })).toBeInTheDocument()
    // The fullscreen copy is a real re-render of the same chart, resized.
    expect(within(dialog).getByTestId('fullscreen-monthly-chart-test-monthly')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('runs the exporters the caller supplied, and hides the menu without them', async () => {
    const onExportPng = vi.fn()
    const onExportExcel = vi.fn()
    renderChart({ onExportPng, onExportExcel })

    fireEvent.click(screen.getByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'تصدير كصورة PNG' }))
    expect(onExportPng).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'تصدير Excel' }))
    expect(onExportExcel).toHaveBeenCalledTimes(1)
  })

  it('plots whatever series it is given, with no business vocabulary of its own', () => {
    renderChart({
      data: [month('2026-01', 'يناير 2026', 10, 20)],
      series: [
        { key: 'expenses', label: 'المصروفات', color: 'var(--destructive)' },
        { key: 'sales', label: 'المبيعات', color: 'var(--success)' },
      ],
      title: 'المبيعات مقابل المصروفات',
    })

    expect(screen.getByRole('heading', { name: 'المبيعات مقابل المصروفات' })).toBeInTheDocument()
    expect(screen.getByText('المصروفات')).toBeInTheDocument()
    expect(screen.getByText('المبيعات')).toBeInTheDocument()
  })
})

describe('MonthlyComparisonBarChart without export callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders no actions menu at all', () => {
    renderChart()
    expect(screen.queryByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' })).toBeNull()
  })
})

describe('MonthlyComparisonBarChart in the stacked layout', () => {
  it('gives every series its own themed colour on the shared chart container', () => {
    renderChart({ layout: 'stacked', stackId: 'expenses' })

    // The colour of a segment is published as a `--color-<key>` custom property
    // by the shared container, so two categories can never be painted alike.
    const container = document.querySelector('[data-chart="container"]')
    expect(container).not.toBeNull()
    const style = (container as HTMLElement).getAttribute('style') ?? ''
    expect(style).toContain('--color-cash: var(--success)')
    expect(style).toContain('--color-visa: var(--info)')
  })

  it('keeps the legend mapping each colour to its category and its latest value', () => {
    renderChart({ layout: 'stacked', stackId: 'expenses' })

    expect(screen.getByText('كاش')).toBeInTheDocument()
    expect(screen.getByText('فيزا')).toBeInTheDocument()
    // The bar is the TOTAL, and the indicator still reads that total.
    expect(screen.getByText('25.0%')).toBeInTheDocument()
  })

  it('states the latest month total for assistive technology, not a single series', () => {
    renderChart({ layout: 'stacked', stackId: 'expenses' })

    const image = screen.getByRole('img')
    // February's total is 150 + 100 = 250 — the bar, not either segment alone.
    expect(image.getAttribute('aria-label')).toContain('250')
  })

  it('re-renders the same stacked chart inside the shared fullscreen dialog', async () => {
    renderChart({ layout: 'stacked', stackId: 'expenses' })

    fireEvent.click(screen.getByRole('button', { name: /تكبير الرسم البياني/ }))

    const dialog = await screen.findByRole('dialog', { name: 'تكبير الرسم البياني' })
    const fullscreen = within(dialog).getByTestId('fullscreen-monthly-chart-test-monthly')
    expect(fullscreen).toBeInTheDocument()
    // The categories and the reading survive the resize, so it is the same
    // stacked chart and not a re-implementation that lost the stack.
    expect(within(dialog).getByText('كاش')).toBeInTheDocument()
    expect(within(dialog).getByText('فيزا')).toBeInTheDocument()
    expect(within(dialog).getByText('25.0%')).toBeInTheDocument()
  })

  it('stays with one reading per chart: the total, never a category against a category', () => {
    // Cash rose 100 → 150 (+50%) while visa did not move. The chart must report
    // the +25% of the TOTAL, which is the only reading a stacked bar can mean.
    renderChart({ layout: 'stacked', stackId: 'expenses' })

    expect(screen.getByText('25.0%')).toBeInTheDocument()
    expect(screen.queryByText('50.0%')).not.toBeInTheDocument()
  })
})
