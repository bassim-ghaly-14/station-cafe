import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PrintPreview } from '@/services/posApi'
import { ThermalReceipt } from './ThermalReceipt'

function preview(over: Partial<PrintPreview> = {}): PrintPreview {
  return {
    doc_type: 'CAFE_INVOICE',
    paper_mm: 80,
    width_chars: 42,
    ops: [
      {
        kind: 'logo',
        width_dots: 240,
        height_dots: 240,
        bits_hex: 'ff00'.repeat(240),
        align: 'center',
      },
      { kind: 'text', text: 'ستيشن كافيه', align: 'center', bold: true, width: 1, height: 1 },
      {
        kind: 'text',
        text: 'Station Cafe - Cafe & Car Wash',
        align: 'center',
        bold: false,
        width: 1,
        height: 1,
      },
      { kind: 'text', text: 'Invoice 1001', align: 'right', bold: false, width: 1, height: 1 },
      {
        kind: 'text',
        text: '--------------------',
        align: 'right',
        bold: false,
        width: 1,
        height: 1,
      },
      {
        kind: 'item',
        name: 'قهوة عربية طويلة اسم المنتج',
        quantity: '2',
        unit_price: '50.00',
        line_total: '100.00',
        align: 'right',
      },
      {
        kind: 'text',
        text: '--------------------',
        align: 'right',
        bold: false,
        width: 1,
        height: 1,
      },
      {
        kind: 'financial',
        label: 'الإجمالي الفرعي',
        value: '100.00',
        total: false,
        align: 'right',
      },
      { kind: 'financial', label: 'الخصم', value: '20.00', total: false, align: 'right' },
      { kind: 'financial', label: 'الإجمالي', value: '80.00', total: true, align: 'right' },
      {
        kind: 'text',
        text: 'شكراً لزيارتكم — Station Cafe',
        align: 'center',
        bold: false,
        width: 1,
        height: 1,
      },
      { kind: 'text', text: '01154520775', align: 'center', bold: false, width: 1, height: 1 },
      { kind: 'cut' },
    ],
    ...over,
  }
}

describe('ThermalReceipt — professional 80mm screen presentation', () => {
  it('keeps physical 80mm and the authoritative 42-cell logical width', () => {
    render(<ThermalReceipt preview={preview()} />)
    const paper = screen.getByLabelText('معاينة الإيصال الحراري')

    expect(paper.style.width).toBe('80mm')
    expect(paper).toHaveAttribute('data-paper-mm', '80')
    expect(paper).toHaveAttribute('data-width-chars', '42')
    expect(paper).toHaveAttribute('dir', 'ltr')
  })

  it('uses a stable 42-cell column contract and wraps only the item name', () => {
    render(<ThermalReceipt preview={preview()} />)
    const header = screen.getByTestId('receipt-item-columns')
    const row = screen.getByTestId('receipt-item-row')

    expect(header.style.gridTemplateColumns).toBe('22ch 3ch 7ch 7ch')
    expect(header.style.columnGap).toBe('1ch')
    expect(row.style.gridTemplateColumns).toBe('22ch 3ch 7ch 7ch')
    expect(row.style.columnGap).toBe('1ch')
    expect(within(row).getByText('2')).toHaveClass('text-center', 'tabular-nums')
    expect(within(row).getByText('100.00')).toHaveClass(
      'text-end',
      'tabular-nums',
      'font-extrabold',
    )
    expect(within(row).getByText('قهوة عربية طويلة اسم المنتج')).toHaveClass(
      '[overflow-wrap:anywhere]',
    )
  })

  it('makes TOTAL the dominant financial anchor in authoritative operation order', () => {
    render(<ThermalReceipt preview={preview()} />)
    const rows = screen.getAllByTestId(/receipt-(financial-row|total)/)
    const total = screen.getByTestId('receipt-total')
    const summary = screen.getAllByTestId('receipt-financial-row')[0]

    expect(rows.map((row) => row.textContent)).toEqual([
      'الإجمالي الفرعي100.00',
      'الخصم20.00',
      'الإجمالي80.00',
    ])
    expect(Number.parseFloat(total.style.fontSize)).toBe(18)
    expect(Number.parseFloat(total.style.fontSize)).toBeGreaterThan(
      Number.parseFloat(summary.style.fontSize) * 2,
    )
    expect(Number.parseInt(total.style.fontWeight)).toBeGreaterThan(
      Number.parseInt(summary.style.fontWeight),
    )
  })

  it('uses the high-resolution canonical source for the browser logo', () => {
    render(<ThermalReceipt preview={preview()} />)
    const logo = screen.getByTestId('print-logo')

    expect(logo).toHaveAttribute('src', '/station-print.png')
    expect(logo).toHaveAttribute('width', '118')
    expect(logo).toHaveAttribute('height', '118')
    expect(logo.style.imageRendering).toBe('auto')
  })

  it('keeps the business phone exactly once and LTR-safe inside RTL content', () => {
    render(
      <div dir="rtl">
        <ThermalReceipt preview={preview()} />
      </div>,
    )
    expect(screen.getAllByText('01154520775')).toHaveLength(1)
    expect(screen.getByText('01154520775')).toHaveAttribute('dir', 'ltr')
  })
})
