import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/lib/i18n'
import type { PreviewOp, PrintPreview } from '@/services/posApi'
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
      {
        kind: 'text',
        text: 'ستيشن كافيه',
        align: 'center',
        bold: true,
        width: 1,
        height: 1,
      },
      {
        kind: 'text',
        text: 'Station Cafe - Cafe & Car Wash',
        align: 'center',
        bold: false,
        width: 1,
        height: 1,
      },
      {
        kind: 'text',
        text: 'Invoice 1001',
        align: 'right',
        bold: false,
        width: 1,
        height: 1,
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
      {
        kind: 'financial',
        label: 'الخصم',
        value: '20.00',
        total: false,
        align: 'right',
      },
      {
        kind: 'financial',
        label: 'الإجمالي',
        value: '80.00',
        total: true,
        align: 'right',
      },
      {
        kind: 'text',
        text: 'شكراً لزيارتكم — Station Cafe',
        align: 'center',
        bold: false,
        width: 1,
        height: 1,
      },
      {
        kind: 'text',
        text: '01154520775',
        align: 'center',
        bold: false,
        width: 1,
        height: 1,
      },
      {
        kind: 'cut',
      },
    ],
    ...over,
  }
}

/** The identity block the backend's invoice print layer now emits. */
function metaOps(): PreviewOp[] {
  return [
    {
      kind: 'meta',
      label: 'التاريخ',
      value: '25/09/2026',
      emphasis: true,
      align: 'right',
    },
    {
      kind: 'meta',
      label: 'الوقت',
      value: '05:30 PM',
      emphasis: true,
      align: 'right',
    },
    {
      kind: 'meta',
      label: 'رقم الفاتورة',
      value: '1001',
      emphasis: false,
      align: 'right',
    },
    {
      kind: 'meta',
      label: 'العميل',
      value: 'أحمد',
      emphasis: false,
      align: 'right',
    },
  ]
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
      'min-w-0',
      'wrap-anywhere',
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

  it('maps text size dimensions with a dense, font-size-derived line box', () => {
    render(
      <ThermalReceipt
        preview={preview({
          ops: [
            { kind: 'text', text: '1x1', align: 'left', bold: false, width: 1, height: 1 },
            { kind: 'text', text: '2x1', align: 'left', bold: false, width: 2, height: 1 },
            { kind: 'text', text: '1x2', align: 'left', bold: false, width: 1, height: 2 },
            { kind: 'text', text: '2x2', align: 'left', bold: false, width: 2, height: 2 },
            { kind: 'text', text: '3x3', align: 'left', bold: false, width: 3, height: 3 },
            { kind: 'text', text: 'bold 3x3', align: 'left', bold: true, width: 3, height: 3 },
          ],
        })}
      />,
    )

    const sizes = ['1x1', '2x1', '1x2', '2x2', '3x3'].map((label) => screen.getByText(label))
    const fontSizes = sizes.map((node) => Number.parseFloat(node.style.fontSize))
    const lineHeights = sizes.map((node) => Number.parseFloat(node.style.lineHeight))

    expect(sizes.map((node) => node.dataset.previewTextSize)).toEqual([
      '1x1',
      '2x1',
      '1x2',
      '2x2',
      '3x3',
    ])
    expect(fontSizes).toEqual([8, 9.44, 9.76, 11.36, 12.96])
    expect(fontSizes[1]).toBeGreaterThan(fontSizes[0])
    expect(fontSizes[2]).toBeGreaterThan(fontSizes[0])
    expect(fontSizes[3]).toBeGreaterThan(fontSizes[1])
    expect(fontSizes[3]).toBeGreaterThan(fontSizes[2])
    expect(fontSizes[4]).toBeGreaterThan(fontSizes[3])
    expect(lineHeights).toEqual(fontSizes.map((fontSize) => fontSize * 1.18))
    expect(screen.getByText('bold 3x3').style.fontSize).toBe('12.96px')
    expect(sizes.every((node) => node.style.transform === '')).toBe(true)
  })

  it('applies semantic bold, alignment, and Arabic direction to text operations', () => {
    render(
      <ThermalReceipt
        preview={preview({
          ops: [
            { kind: 'text', text: 'عادي', align: 'right', bold: false, width: 1, height: 1 },
            { kind: 'text', text: 'عريض', align: 'center', bold: true, width: 2, height: 1 },
            { kind: 'text', text: 'عربي طويل', align: 'right', bold: false, width: 1, height: 2 },
            { kind: 'text', text: 'عربي ضخم', align: 'right', bold: true, width: 3, height: 3 },
            { kind: 'text', text: 'Latin', align: 'left', bold: false, width: 1, height: 1 },
          ],
        })}
      />,
    )

    const normal = screen.getByText('عادي')
    const bold = screen.getByText('عريض')
    const arabicTall = screen.getByText('عربي طويل')
    const arabicMax = screen.getByText('عربي ضخم')
    const latin = screen.getByText('Latin')

    expect(normal).toHaveAttribute('dir', 'rtl')
    expect(normal.style.textAlign).toBe('right')
    expect(normal.style.fontWeight).toBe('400')
    expect(bold).toHaveAttribute('dir', 'rtl')
    expect(bold.style.textAlign).toBe('center')
    expect(bold.style.fontWeight).toBe('750')
    expect(arabicTall).toHaveAttribute('dir', 'rtl')
    expect(arabicTall.style.fontSize).toBe('9.76px')
    expect(arabicMax).toHaveAttribute('dir', 'rtl')
    expect(arabicMax.style.fontSize).toBe('12.96px')
    expect(arabicMax.style.fontWeight).toBe('750')
    expect(latin).toHaveAttribute('dir', 'ltr')
    expect(latin.style.textAlign).toBe('left')
  })

  it('keeps semantic item and financial rendering intact', () => {
    render(<ThermalReceipt preview={preview()} />)

    expect(screen.getByTestId('receipt-item-row')).toHaveStyle({
      gridTemplateColumns: '22ch 3ch 7ch 7ch',
    })
    expect(screen.getByTestId('receipt-total')).toHaveStyle({
      fontSize: '18px',
      fontWeight: '800',
    })
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

  // ---------------------------------------------------------------------
  // The identity block: one printable-width canvas, and a type hierarchy.
  // ---------------------------------------------------------------------

  it('lays every section on one printable-width canvas derived from the preview', () => {
    render(
      <ThermalReceipt
        preview={preview({
          width_chars: 42,
          ops: [
            ...metaOps(),
            {
              kind: 'item',
              name: 'قهوة',
              quantity: '2',
              unit_price: '50.00',
              line_total: '100.00',
              align: 'right',
            },
            { kind: 'financial', label: 'الإجمالي', value: '100.00', total: true, align: 'right' },
          ],
        })}
      />,
    )

    // The canvas is the authoritative cell count — not a per-section width, not
    // a margin, and not the physical paper width. This is what stops the
    // metadata from collapsing onto one side of the receipt.
    const canvas = screen.getByTestId('receipt-canvas')
    expect(canvas.style.width).toBe('42ch')
    expect(canvas.style.maxWidth).toBe('100%')
    expect(canvas.style.marginInline).toBe('auto')
    // `ch` must resolve against the base cell size, not an inherited font.
    expect(canvas.style.fontSize).toBe('8px')

    // The identity block and the item table therefore share the same width.
    const itemRow = screen.getByTestId('receipt-item-row')
    expect(itemRow.style.gridTemplateColumns).toBe('22ch 3ch 7ch 7ch')
    const columns = ['22ch', '3ch', '7ch', '7ch']
      .map((track) => Number.parseFloat(track))
      .reduce((sum, track) => sum + track, 0)
    // 39 tracks + 3 one-cell gaps = the full 42-cell canvas.
    expect(columns + 3).toBe(Number.parseFloat(canvas.style.width))
  })

  it('renders each metadata row as a full-width two-column row, not a padded string', () => {
    render(<ThermalReceipt preview={preview({ ops: metaOps() })} />)

    const rows = screen.getAllByTestId('receipt-meta-row')
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.textContent)).toEqual([
      'التاريخ25/09/2026',
      'الوقت05:30 PM',
      'رقم الفاتورة1001',
      'العميلأحمد',
    ])

    for (const row of rows) {
      // A real grid across the whole canvas, with the value in its own column.
      expect(row).toHaveClass('grid')
      expect(row.style.gridTemplateColumns).toBe('1fr auto')
      // No per-row width: the row is laid out by the shared canvas, which is
      // exactly why it can no longer hug one side of the receipt.
      expect(row.style.width).toBe('')
    }
  })

  it('emphasises the document moment by weight only, never by bulk', () => {
    render(<ThermalReceipt preview={preview({ ops: metaOps() })} />)

    const [date, time, invoiceNo, customer] = screen.getAllByTestId('receipt-meta-row')

    // Date and time are the emphasised rows.
    expect(date.dataset.emphasis).toBe('true')
    expect(time.dataset.emphasis).toBe('true')
    // Low-priority metadata is not.
    expect(invoiceNo.dataset.emphasis).toBe('false')
    expect(customer.dataset.emphasis).toBe('false')

    // Hierarchy, not size: nothing in the block is enlarged, the emphasised
    // rows are only heavier, and all of them stay below the document total.
    for (const row of [date, time, invoiceNo, customer]) {
      expect(row.style.fontSize).toBe('8px')
    }
    expect(Number.parseInt(date.style.fontWeight, 10)).toBeGreaterThan(
      Number.parseInt(customer.style.fontWeight, 10),
    )

    // And a generous line box, so a stack of metadata is not cramped.
    expect(date.style.lineHeight).toBe('11.6px')
  })

  it('keeps the metadata hierarchy below the document total', () => {
    render(
      <ThermalReceipt
        preview={preview({
          ops: [
            ...metaOps(),
            { kind: 'financial', label: 'الإجمالي', value: '100.00', total: true, align: 'right' },
          ],
        })}
      />,
    )

    const metadata = screen.getAllByTestId('receipt-meta-row')
    const total = screen.getByTestId('receipt-total')
    for (const row of metadata) {
      expect(Number.parseFloat(row.style.fontSize)).toBeLessThan(
        Number.parseFloat(total.style.fontSize),
      )
    }
  })
})
