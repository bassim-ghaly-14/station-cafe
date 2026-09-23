/**
 * Screen presentation for the authoritative backend print IR. Physical paper
 * stays 80mm; this renderer supplies a readable 42-cell visual grid and the
 * dialog's scaling layer scales the complete paper as one unit.
 */
import type { ReactNode } from 'react'
import type { PreviewFinancialOp, PreviewItemOp, PrintPreview } from '@/services/posApi'

const CELL_PX = 8
const BODY_SIZE = CELL_PX
const META_SIZE = 8
const TOTAL_SIZE = 18
const LOGO_MM = 31

export function ThermalReceipt({ preview }: { preview: PrintPreview }) {
  let separatorIndex = 0
  let itemHeaderShown = false

  return (
    <article
      dir="ltr"
      aria-label="معاينة الإيصال الحراري"
      data-testid="print-receipt-paper"
      data-paper-mm={preview.paper_mm}
      data-width-chars={preview.width_chars}
      className="receipt-paper relative box-border w-full overflow-hidden border border-[#d8cbb8] bg-[#fffdf8] font-mono text-[#211c17] shadow-[0_18px_45px_-18px_rgba(43,29,18,0.45)]"
      style={{ width: `${preview.paper_mm}mm` }}
    >
      <div className="receipt-content px-[4mm] py-[5mm]">
        {preview.ops.map((op, index) => {
          switch (op.kind) {
            case 'logo':
              return <ScreenLogo key={index} align={op.align} />
            case 'item':
              return (
                <div key={index}>
                  {!itemHeaderShown ? <ItemColumnHeader /> : null}
                  <ItemRow op={op} />
                  {itemHeaderShown ? null : (itemHeaderShown = true)}
                </div>
              )
            case 'financial':
              return <FinancialRow key={index} op={op} />
            case 'text': {
              if (/^-{20,}$/.test(op.text)) {
                const current = separatorIndex
                separatorIndex += 1
                // The printer's first rule repeats the header edge. The screen
                // keeps the three rules that communicate document structure.
                if (current === 0) return <div key={index} className="h-0.5" aria-hidden />
                return (
                  <div
                    key={index}
                    role="separator"
                    className="my-[2.5mm] h-px border-t border-dashed border-[#776b5e]"
                  />
                )
              }
              const arabic = /^[\p{Script=Arabic}\s]/u.test(op.text)
              return (
                <p
                  key={index}
                  dir={arabic ? 'rtl' : 'ltr'}
                  className="m-0 whitespace-pre-wrap wrap-break-words"
                  style={{
                    textAlign: op.align,
                    fontSize: `${op.bold ? 9.5 : op.height > 1 ? 11 : META_SIZE}px`,
                    fontWeight: op.bold ? 750 : 450,
                    lineHeight: `${BODY_SIZE * 1.28}px`,
                    unicodeBidi: 'plaintext',
                    direction: arabic ? 'rtl' : 'ltr',
                  }}
                >
                  {op.text}
                </p>
              )
            }
            case 'feed':
              return (
                <div key={index} aria-hidden style={{ height: `${op.lines * CELL_PX * 1.28}px` }} />
              )
            case 'cut':
              return <PaperCut key={index} />
          }
        })}
      </div>
    </article>
  )
}

function ItemColumnHeader() {
  return (
    <div
      data-testid="receipt-item-columns"
      className="mb-[1.5mm] grid border-b border-[#776b5e] pb-[1mm] font-bold text-[#5c5146]"
      style={{ gridTemplateColumns: '22ch 3ch 7ch 7ch', columnGap: '1ch', fontSize: 7.5 }}
    >
      <span>ITEM</span>
      <span className="text-center">QTY</span>
      <span className="text-end">PRICE</span>
      <span className="text-end">TOTAL</span>
    </div>
  )
}

function ItemRow({ op }: { op: PreviewItemOp }) {
  return (
    <div
      data-testid="receipt-item-row"
      dir="ltr"
      className="grid min-h-[5mm] items-start border-b border-[#ded5c8] py-[1mm] last:border-b-0"
      style={{ gridTemplateColumns: '22ch 3ch 7ch 7ch', columnGap: '1ch', fontSize: BODY_SIZE }}
    >
      <span dir="auto" className="min-w-0 wrap-anywhere font-semibold leading-tight">
        {op.name}
      </span>
      <span dir="ltr" className="text-center font-bold tabular-nums">
        {op.quantity}
      </span>
      <Money>{op.unit_price}</Money>
      <Money strong>{op.line_total}</Money>
    </div>
  )
}

function FinancialRow({ op }: { op: PreviewFinancialOp }) {
  return (
    <div
      data-testid={op.total ? 'receipt-total' : 'receipt-financial-row'}
      dir="rtl"
      className={
        op.total
          ? 'my-[2.5mm] grid grid-cols-[1fr_auto] items-baseline gap-[2ch] border-y-2 border-[#211c17] bg-[#f4eee4] px-[2mm] py-[2mm] text-[#17130f]'
          : 'grid grid-cols-[1fr_auto] items-baseline gap-[2ch] px-[1mm] py-[0.7mm]'
      }
      style={{
        fontSize: op.total ? TOTAL_SIZE : META_SIZE,
        fontWeight: op.total ? 800 : 500,
        lineHeight: 1.18,
      }}
    >
      <span dir="rtl">{op.label}</span>
      <Money strong={op.total}>{op.value}</Money>
    </div>
  )
}

function Money({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      dir="ltr"
      className={`text-end tabular-nums ${strong ? 'font-extrabold' : 'font-semibold'}`}
    >
      {children}
    </span>
  )
}

/** The canonical 1254px source is used for screens; ESC/POS still uses its raster. */
function ScreenLogo({ align }: { align: 'left' | 'center' | 'right' }) {
  return (
    <div
      className="mb-[3mm] flex"
      style={{
        justifyContent:
          align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      <img
        data-testid="print-logo"
        src="/station-print.png"
        alt=""
        width={118}
        height={118}
        className="block max-w-full object-contain"
        style={{ width: `${LOGO_MM}mm`, height: `${LOGO_MM}mm`, imageRendering: 'auto' }}
      />
    </div>
  )
}

function PaperCut() {
  return <div data-testid="print-paper-cut" className="mt-[4mm] h-1.75 bg-[#776b5e]" />
}
