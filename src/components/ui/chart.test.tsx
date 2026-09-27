/**
 * The shared tooltip content: the rows it prints, the zero rows it may hide, and
 * the total line a chart can add underneath. It is chart-agnostic, so it is
 * tested with a plain payload rather than through any one chart.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChartTooltipContent } from './chart'

const PAYLOAD = [
  { dataKey: 'SALARY', value: 12_000, color: 'var(--primary)', payload: { label: 'رواتب' } },
  { dataKey: 'SUPPLIES', value: 0, color: 'var(--info)', payload: { label: 'مشتريات' } },
  { dataKey: 'UTILITIES', value: 3_500, color: 'var(--warning)', payload: { label: 'مرافق' } },
]

describe('ChartTooltipContent', () => {
  it('prints every row of the payload with its colour and value', () => {
    render(
      <ChartTooltipContent
        active
        payload={PAYLOAD}
        label="يناير 2026"
        formatter={(value) => new Intl.NumberFormat('en-US').format(Number(value))}
      />,
    )

    expect(screen.getByText('يناير 2026')).toBeInTheDocument()
    expect(screen.getByText('رواتب')).toBeInTheDocument()
    expect(screen.getByText('12,000')).toBeInTheDocument()
    // By default a zero IS a row: a chart that draws a zero bar must name it.
    expect(screen.getByText('مشتريات')).toBeInTheDocument()
  })

  it('hides the zero rows on request, and keeps the rest', () => {
    render(<ChartTooltipContent active payload={PAYLOAD} label="يناير 2026" hideZeroValues />)

    expect(screen.queryByText('مشتريات')).not.toBeInTheDocument()
    expect(screen.getByText('رواتب')).toBeInTheDocument()
    expect(screen.getByText('مرافق')).toBeInTheDocument()
  })

  it('renders a plain footer line', () => {
    render(
      <ChartTooltipContent
        active
        payload={PAYLOAD}
        footer={
          <>
            <span>الإجمالي</span>
            <span>15,500</span>
          </>
        }
      />,
    )

    expect(screen.getByText('الإجمالي')).toBeInTheDocument()
    expect(screen.getByText('15,500')).toBeInTheDocument()
  })

  it('gives a footer function the payload, so the total comes from the hovered row', () => {
    render(
      <ChartTooltipContent
        active
        payload={PAYLOAD}
        footer={(items) => <span>{items.length} فئات</span>}
      />,
    )

    expect(screen.getByText('3 فئات')).toBeInTheDocument()
  })

  it('names a row by its MARK, not by the datum label a time chart carries', () => {
    // A monthly chart's datum holds the axis month in `label`, so reading that
    // field would print the month as the name of every series of the month.
    render(
      <ChartTooltipContent
        active
        label="سبتمبر 2026"
        payload={[
          {
            dataKey: 'cafe',
            name: 'cafe',
            value: 25_400,
            color: 'var(--info)',
            payload: { label: 'سبتمبر' },
          },
          {
            dataKey: 'wash',
            name: 'wash',
            value: 8_500,
            color: 'var(--primary)',
            payload: { label: 'سبتمبر' },
          },
        ]}
      />,
    )

    // The heading states the PERIOD, and the rows state the ENTITY.
    expect(screen.getByText('سبتمبر 2026')).toBeInTheDocument()
    expect(screen.getByText('cafe')).toBeInTheDocument()
    expect(screen.getByText('wash')).toBeInTheDocument()
    // The month is period context only: it is never a row's name.
    expect(screen.queryByText('سبتمبر')).not.toBeInTheDocument()
  })

  it('still falls back to the datum label for a chart that names rows with it', () => {
    // A pie sets `nameKey="label"`, so there the datum's label IS the category.
    // The rows above use `name`; these use no name at all.
    render(<ChartTooltipContent active payload={PAYLOAD} />)

    expect(screen.getByText('رواتب')).toBeInTheDocument()
    expect(screen.getByText('مرافق')).toBeInTheDocument()
  })

  it('prints the name the CHART resolves, so a key never reaches the reader', () => {
    // The mark's `name` is the series KEY. The chart that owns the series says
    // what it reads like — here the Arabic name, with the key nowhere in sight.
    render(
      <ChartTooltipContent
        active
        payload={[
          { dataKey: 'MAINTENANCE', name: 'MAINTENANCE', value: 8_500, color: 'var(--info)' },
        ]}
        itemLabel={(_item, key) => (key === 'MAINTENANCE' ? 'صيانة' : '')}
        formatter={(value) => `${Number(value).toLocaleString('en-US')} ج.م`}
      />,
    )

    expect(screen.getByText('صيانة')).toBeInTheDocument()
    expect(screen.queryByText(/MAINTENANCE/)).not.toBeInTheDocument()
    // The VALUE is still there, and carries the currency as the chart formatted it.
    expect(screen.getByText('8,500 ج.م')).toBeInTheDocument()
  })

  it('prints no name at all when the chart resolves none, never the key', () => {
    render(
      <ChartTooltipContent
        active
        payload={[{ dataKey: 'RETIRED', name: 'RETIRED', value: 100 }]}
        itemLabel={() => ''}
      />,
    )

    expect(screen.queryByText('RETIRED')).not.toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })

  it('bolds the name only when the chart asks for it', () => {
    const payload = [{ dataKey: 'cafe', name: 'cafe', value: 100 }]
    const { rerender } = render(<ChartTooltipContent active payload={payload} />)
    expect(screen.getByText('cafe')).not.toHaveClass('font-bold')

    rerender(<ChartTooltipContent active payload={payload} boldItemLabel />)
    // The project's bold weight, the same `font-bold` the rest of the UI uses.
    expect(screen.getByText('cafe')).toHaveClass('font-bold')
  })

  it('renders nothing when it is not active or has no payload', () => {
    const { container, rerender } = render(
      <ChartTooltipContent active={false} payload={PAYLOAD} label="يناير 2026" />,
    )
    expect(container).toBeEmptyDOMElement()

    rerender(<ChartTooltipContent active payload={[]} label="يناير 2026" />)
    expect(container).toBeEmptyDOMElement()
  })
})
