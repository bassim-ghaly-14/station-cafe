/**
 * Screen presentation for the authoritative backend print IR. Physical paper
 * stays 80mm; this renderer supplies a readable 42-cell visual grid and the
 * dialog's scaling layer scales the complete paper as one unit.
 */
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PreviewFinancialOp,
  PreviewItemOp,
  PreviewMetaOp,
  PreviewTextOp,
  PrintPreview,
} from '@/services/posApi'

const CELL_PX = 8
const BODY_SIZE = CELL_PX
const META_SIZE = 8
/**
 * Metadata line box. A little more open than the tight item rows so a block of
 * identity lines reads as a scannable section rather than a cramped stack.
 */
const META_LINE_RHYTHM = 1.45
const TOTAL_SIZE = 18

/** Conservative typographic equivalents for the ESC/POS text multipliers. */
const TEXT_MODE_SIZE: Record<string, number> = {
  '1x1': 1,
  '2x1': 1.18,
  '1x2': 1.22,
  '2x2': 1.42,
  '3x3': 1.62,
}
const TEXT_LINE_RHYTHM = 1.18

function textStyle(op: PreviewTextOp): CSSProperties {
  const width = Math.max(1, Math.min(3, op.width))
  const height = Math.max(1, Math.min(3, op.height))
  const modeSize = TEXT_MODE_SIZE[`${width}x${height}`] ?? TEXT_MODE_SIZE['1x1']
  const fontSize = META_SIZE * modeSize
  return {
    textAlign: op.align,
    fontSize: `${fontSize}px`,
    fontWeight: op.bold ? 750 : 400,
    lineHeight: `${fontSize * TEXT_LINE_RHYTHM}px`,
    unicodeBidi: 'plaintext',
  }
}

const LOGO_MM = 31

/**
 * A stable key for each op in the print IR.
 *
 * The ops are an ordered document, not a re-orderable list: nothing is ever
 * inserted, removed or moved within one render, so the op's own position IS its
 * identity and is what React needs. The key is stated in terms of the op rather
 * than a bare loop counter so that reordering the switch can never silently pair
 * a key with the wrong op, and repeated identical ops (two separators, say)
 * still get distinct keys because the position is part of it.
 */
function opKey(op: { kind: string }, position: number): string {
  return `${op.kind}-${position}`
}

export function ThermalReceipt({ preview }: Readonly<{ readonly preview: PrintPreview }>) {
  const { t } = useTranslation()
  let separatorIndex = 0
  let itemHeaderShown = false

  // The one printable-width model of the whole document. The paper is
  // physically 80mm, but what a document can actually print is `width_chars`
  // fixed character cells, so every section — header, identity block, item
  // table, totals — is laid out on exactly this canvas. It is derived from the
  // authoritative preview (never hardcoded per template) and centred on the
  // paper, which is what stops any one section from sitting on a single side.
  const canvas: CSSProperties = {
    width: `${preview.width_chars}ch`,
    maxWidth: '100%',
    marginInline: 'auto',
    fontSize: META_SIZE,
  }

  return (
    <article
      dir="ltr"
      aria-label={t('print.previewSurface')}
      data-testid="print-receipt-paper"
      data-paper-mm={preview.paper_mm}
      data-width-chars={preview.width_chars}
      className="receipt-paper relative box-border w-full overflow-hidden border border-print-border bg-print-paper px-[2mm] py-[2.5mm] font-mono text-print-ink shadow-paper"
      style={{ width: `${preview.paper_mm}mm` }}
    >
      <div data-testid="receipt-canvas" className="receipt-content" style={canvas}>
        {preview.ops.map((op, index) => {
          const key = opKey(op, index)
          switch (op.kind) {
            case 'logo':
              return <ScreenLogo key={key} align={op.align} />
            case 'item':
              // The column header is emitted by the first item only. Assigning it
              // as its own statement keeps the render pure and readable.
              if (!itemHeaderShown) {
                itemHeaderShown = true
                return (
                  <div key={key}>
                    <ItemColumnHeader />
                    <ItemRow op={op} />
                  </div>
                )
              }
              return (
                <div key={key}>
                  <ItemRow op={op} />
                </div>
              )
            case 'financial':
              return <FinancialRow key={key} op={op} />
            case 'meta':
              return <MetaRow key={key} op={op} />
            case 'text': {
              if (/^-{20,}$/.test(op.text)) {
                const current = separatorIndex
                separatorIndex += 1
                // The printer's first rule repeats the header edge. The screen
                // keeps the three rules that communicate document structure.
                if (current === 0) return <div key={key} className="h-0.5" aria-hidden />
                return (
                  <hr
                    key={key}
                    className="my-[1.5mm] h-px border-0 border-t border-dashed border-print-rule"
                  />
                )
              }
              const arabic = /^[\p{Script=Arabic}\s]/u.test(op.text)
              return (
                <p
                  key={key}
                  dir={arabic ? 'rtl' : 'ltr'}
                  data-preview-text-size={`${op.width}x${op.height}`}
                  className="m-0 whitespace-pre-wrap wrap-break-words"
                  style={{
                    ...textStyle(op),
                    direction: arabic ? 'rtl' : 'ltr',
                  }}
                >
                  {op.text}
                </p>
              )
            }
            case 'feed':
              return (
                <div key={key} aria-hidden style={{ height: `${op.lines * CELL_PX * 1.28}px` }} />
              )
            case 'cut':
              return <PaperCut key={key} />
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
      // The same cell size as the rows below, so the column header's tracks land
      // on exactly the same character columns.
      className="mb-[1.5mm] grid border-b border-print-rule pb-[1mm] font-bold text-print-ink-muted"
      style={{
        gridTemplateColumns: '22ch 3ch 7ch 7ch',
        columnGap: '1ch',
        fontSize: BODY_SIZE,
      }}
    >
      <span>ITEM</span>
      <span className="text-center">QTY</span>
      <span className="text-end">PRICE</span>
      <span className="text-end">TOTAL</span>
    </div>
  )
}

function ItemRow({ op }: Readonly<{ readonly op: PreviewItemOp }>) {
  return (
    <div
      data-testid="receipt-item-row"
      dir="ltr"
      className="grid min-h-[5mm] items-start border-b border-print-rule-subtle py-[1mm] last:border-b-0"
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

/**
 * One row of the invoice/receipt identity block.
 *
 * It spans the same 42-cell canvas as the item table below it, so the block
 * occupies the whole receipt width instead of hugging one side — the fix for a
 * header that used to leave the left half of the paper empty.
 *
 * The hierarchy is weight, not bulk: emphasised rows (the document's date and
 * time) are heavier, never larger, and always stay below the title and the
 * document total.
 */
function MetaRow({ op }: Readonly<{ readonly op: PreviewMetaOp }>) {
  return (
    <div
      data-testid="receipt-meta-row"
      data-emphasis={op.emphasis}
      dir="rtl"
      className="grid min-h-[4mm] items-baseline border-b border-print-rule-subtle py-[0.9mm] last:border-b-0"
      style={{
        gridTemplateColumns: '1fr auto',
        columnGap: '2ch',
        fontSize: `${META_SIZE}px`,
        fontWeight: op.emphasis ? 700 : 450,
        lineHeight: `${META_SIZE * META_LINE_RHYTHM}px`,
      }}
    >
      <span dir="rtl" className="min-w-0 wrap-anywhere text-print-ink-muted">
        {op.label}
      </span>
      <Money strong={op.emphasis}>{op.value}</Money>
    </div>
  )
}

function FinancialRow({ op }: Readonly<{ readonly op: PreviewFinancialOp }>) {
  return (
    <div
      data-testid={op.total ? 'receipt-total' : 'receipt-financial-row'}
      dir="rtl"
      className={
        op.total
          ? 'my-[2.5mm] grid grid-cols-[1fr_auto] items-baseline gap-[2ch] border-y-2 border-print-ink bg-print-total-bg px-[2mm] py-[2mm] text-print-total-ink'
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

function Money({
  children,
  strong = false,
}: Readonly<{ readonly children: ReactNode; strong?: boolean }>) {
  return (
    <span
      dir="ltr"
      className={`text-end tabular-nums ${strong ? 'font-extrabold' : 'font-semibold'}`}
    >
      {children}
    </span>
  )
}

/**
 * How the logo is justified inside the receipt, per the op's own alignment.
 *
 * The three values are the only ones the print IR can carry, and they map onto
 * the three flex justifications, so the mapping is stated once here.
 */
function screenLogoJustify(align: 'left' | 'center' | 'right'): CSSProperties['justifyContent'] {
  if (align === 'center') return 'center'
  if (align === 'right') return 'flex-end'
  return 'flex-start'
}

/** The canonical 1254px source is used for screens; ESC/POS still uses its raster. */
function ScreenLogo({ align }: Readonly<{ readonly align: 'left' | 'center' | 'right' }>) {
  return (
    <div className="mb-[3mm] flex" style={{ justifyContent: screenLogoJustify(align) }}>
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
  return <div data-testid="print-paper-cut" className="mt-[4mm] h-1.75 bg-print-rule" />
}
