/**
 * What the monthly tooltip actually PRINTS for a hovered bar — the composition
 * the arithmetic tests and the component tests each see only one half of.
 *
 * The shared primitive is real here and the real resolvers are used, so this
 * proves the two together: a row states the ENTITY by its Arabic name in bold,
 * the VALUE beside it, the month above as period context, and the series key
 * (`MAINTENANCE`, `cafe`) never appears anywhere in the reader's view.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChartTooltipContent } from '@/components/ui/chart'
import {
  seriesTooltipName,
  seriesTooltipValue,
  type MonthlySeriesConfig,
} from './monthlyComparison'

const format = (v: number) => `${v.toLocaleString('en-US')} ج.م`

/** The Sales chart's own series: two comparable business lines. */
const SALES: MonthlySeriesConfig[] = [
  { key: 'cafe', label: 'كافيه', color: 'var(--info)', format },
  { key: 'wash', label: 'مغسلة', color: 'var(--primary)', format },
]
/** The Expenses chart's own series: domain category codes + `name_ar` labels. */
const EXPENSES: MonthlySeriesConfig[] = [
  { key: 'MAINTENANCE', label: 'صيانة', color: 'var(--primary)', format },
  { key: 'ELECTRICITY', label: 'كهرباء', color: 'var(--info)', format },
]

/** The tooltip exactly as the monthly chart configures it. */
function tooltip(series: MonthlySeriesConfig[], values: Record<string, number>) {
  return (
    <ChartTooltipContent
      active
      label="سبتمبر"
      labelFormatter={(_l, items) => {
        const d = items?.[0]?.payload as { fullLabel?: string } | undefined
        return d?.fullLabel ?? ''
      }}
      itemLabel={(_item, key) => seriesTooltipName(series, key)}
      boldItemLabel
      formatter={(value, _name, item) =>
        seriesTooltipValue(series, String(item.dataKey ?? item.name), Number(value), format)
      }
      footer={
        <>
          <span className="text-foreground-muted">إجمالي</span>
          <span className="tabular-nums">28,500 ج.م</span>
        </>
      }
      payload={series.map((s) => ({
        dataKey: s.key,
        name: s.key,
        value: values[s.key] ?? 0,
        color: s.color,
        payload: { label: 'سبتمبر', fullLabel: 'سبتمبر 2026' },
      }))}
    />
  )
}

describe('the production tooltip', () => {
  it('prints Arabic-only bold names for sales and expenses', () => {
    const sales = render(tooltip(SALES, { cafe: 25400, wash: 8500 }))
    expect(screen.getByText('سبتمبر 2026')).toBeInTheDocument()
    expect(screen.getByText('كافيه')).toHaveClass('font-bold')
    expect(screen.getByText('مغسلة')).toHaveClass('font-bold')
    expect(screen.getByText('25,400 ج.م')).toBeInTheDocument()
    expect(sales.container.textContent).not.toMatch(/cafe|wash|يناير/)
    sales.unmount()

    const expenses = render(tooltip(EXPENSES, { MAINTENANCE: 8500, ELECTRICITY: 0 }))
    expect(screen.getByText('صيانة')).toHaveClass('font-bold')
    expect(screen.getByText('كهرباء')).toHaveClass('font-bold')
    expect(screen.getByText('8,500 ج.م')).toBeInTheDocument()
    expect(screen.getByText('إجمالي')).toBeInTheDocument()
    expect(expenses.container.textContent).not.toMatch(/MAINTENANCE|ELECTRICITY/)
  })
})
