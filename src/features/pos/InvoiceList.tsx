/**
 * The invoice records, as a dense table on wide screens and as full records
 * on narrow ones.
 *
 * Row hierarchy, in reading order:
 *   1. the invoice number (the identifier a cashier actually calls out) plus
 *      the external-order number when there is one;
 *   2. its context — table or takeaway, customer, car plate — as quiet second
 *      line information;
 *   3. when it was issued, through the central Station date/time formatter;
 *   4. its status as a badge with a dot AND an icon, so the state is legible
 *      without relying on colour alone;
 *   5. the total, as the second dominant number on the row, with the settled
 *      amount called out whenever it does not equal the total.
 *
 * Payment method is deliberately NOT a column: `search_invoices` returns no
 * per-row payment record, and inventing one would mean either a N+1 fetch per
 * row or a backend change. What a row can honestly show is the payment
 * position — how much of the total is actually settled — and that is what the
 * payment cell renders. The payment METHOD stays a filter, where the backend
 * really does resolve it.
 *
 * Actions: preview is the primary way to inspect a record and the whole row
 * opens it; reprint is the secondary action and keeps a word, because printing
 * deserves a label rather than a bare glyph. Both are the existing POS
 * commands, unchanged.
 *
 * Responsive: below `md` the table is replaced by stacked records rather than
 * a horizontally scrolling table, so nothing important is clipped on a phone.
 */
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  DataTable,
  DataTableCell,
  DataTableRow,
  DisplayDateTime,
  MoneyDisplay,
  type DataTableColumn,
} from '@/components/ui'
import { Check, Clock, Eye, Printer, Wallet } from '@/components/ui/icon'
import { invoiceBadgeVariant } from '@/lib/status-badge'
import { cn } from '@/lib/utils'
import { useIsWide } from '@/lib/use-media-query'
import type { InvoiceRow } from '@/services/posApi'

/** Non-colour status cues. The label stays the primary signal. */
const STATUS_ICON: Record<string, typeof Check> = {
  PAID: Check,
  PARTIALLY_PAID: Clock,
  PENDING_PAYMENT: Clock,
  CREDIT: Wallet,
}

export function InvoiceList({
  rows,
  onPreview,
  onPrint,
  busy = false,
}: {
  rows: readonly InvoiceRow[]
  readonly onPreview: (invoice: InvoiceRow) => void
  readonly onPrint: (invoice: InvoiceRow) => void
  /** A reload is running over rows that are already on screen. */
  readonly busy?: boolean
}) {
  const { t } = useTranslation()

  const columns: DataTableColumn[] = [
    { key: 'invoice', label: t('invoicesPage.columns.invoice'), headerClassName: 'w-40' },
    { key: 'context', label: t('invoicesPage.columns.context'), hideBelow: 'lg' },
    { key: 'time', label: t('invoicesPage.columns.time'), hideBelow: 'sm' },
    { key: 'status', label: t('invoicesPage.columns.status'), headerClassName: 'w-32' },
    { key: 'total', label: t('invoicesPage.columns.total'), headerClassName: 'w-36' },
    { key: 'actions', label: t('invoicesPage.columns.actions'), headerClassName: 'w-48' },
  ]

  // Exactly ONE representation is mounted: a CSS-hidden copy would still be
  // read by a screen reader, parsed by tests, and held twice in memory.
  const wide = useIsWide()

  if (!wide) {
    return (
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="border-b border-border-subtle px-3 py-3 last:border-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <InvoiceIdentity invoice={row} />
                <InvoiceContext invoice={row} className="mt-1" />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <InvoiceTotal invoice={row} />
                <InvoiceStatus invoice={row} />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <InvoiceTime invoice={row} />
              <InvoiceActions invoice={row} onPreview={onPreview} onPrint={onPrint} />
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <DataTable caption={t('pos.todayInvoices')} columns={columns} busy={busy}>
      {rows.map((row) => (
        <DataTableRow key={row.id} onClick={() => onPreview(row)}>
          <DataTableCell>
            <InvoiceIdentity invoice={row} />
          </DataTableCell>
          <DataTableCell className="hidden lg:table-cell">
            <InvoiceContext invoice={row} />
          </DataTableCell>
          <DataTableCell className="hidden sm:table-cell">
            <InvoiceTime invoice={row} />
          </DataTableCell>
          <DataTableCell>
            <InvoiceStatus invoice={row} />
          </DataTableCell>
          <DataTableCell>
            <InvoiceTotal invoice={row} />
          </DataTableCell>
          <DataTableCell>
            <InvoiceActions invoice={row} onPreview={onPreview} onPrint={onPrint} />
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}

/** The issue timestamp, always through the shared Cairo/UTC formatter. */
function InvoiceTime({ invoice }: { invoice: InvoiceRow }) {
  return (
    <DisplayDateTime
      value={invoice.created_at}
      className="text-sm text-foreground-muted"
      separator=""
      stack
    />
  )
}

/** Invoice number as the row's anchor, with the external-order number beside it. */
function InvoiceIdentity({ invoice }: { invoice: InvoiceRow }) {
  const { t } = useTranslation()
  return (
    <span className="block min-w-0">
      <span className="block truncate text-body font-bold text-foreground-strong" dir="ltr">
        #{invoice.invoice_no}
      </span>
      <span className="mt-0.5 block truncate text-caption">
        {invoice.order_type === 'TAKEAWAY' ? (
          typeof invoice.takeaway_no === 'number' ? (
            <span dir="ltr" className="tabular-nums">
              TW-{invoice.takeaway_no}
            </span>
          ) : (
            t('pos.orderType.TAKEAWAY')
          )
        ) : (
          (invoice.table_label ?? t('pos.orderType.TABLE'))
        )}
      </span>
    </span>
  )
}

/** Customer and car — the "who was this for" context, always stated explicitly. */
function InvoiceContext({ invoice, className }: { invoice: InvoiceRow; className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn('block min-w-0', className)}>
      <span className="block truncate text-sm text-foreground-muted">
        {invoice.customer_name ?? t('pos.noCustomer')}
      </span>
      {invoice.car_plate ? (
        <span className="block truncate text-xs text-foreground-subtle" dir="ltr">
          {invoice.car_plate}
        </span>
      ) : null}
    </span>
  )
}

/** Status as label + dot + icon, so colour is never the only signal. */
function InvoiceStatus({ invoice }: { invoice: InvoiceRow }) {
  const { t } = useTranslation()
  return (
    <Badge
      variant={invoiceBadgeVariant(invoice.status)}
      size="sm"
      dot
      icon={STATUS_ICON[invoice.status]}
    >
      {t(`invoice.status.${invoice.status}`)}
    </Badge>
  )
}

/**
 * The total, plus how much of it is actually settled.
 *
 * Both figures come straight from the persisted invoice snapshot — nothing is
 * recomputed here, and a historical invoice is never presented as editable.
 */
function InvoiceTotal({ invoice }: { invoice: InvoiceRow }) {
  const { t } = useTranslation()
  const unsettled = invoice.paid_amount !== invoice.total
  return (
    <span className="block min-w-0">
      <MoneyDisplay amount={invoice.total} className="block text-money text-foreground-strong" />
      {unsettled ? (
        <span className="mt-0.5 block text-xs text-foreground-subtle">
          {t('invoicesPage.settledLabel')}{' '}
          <MoneyDisplay amount={invoice.paid_amount} className="font-bold" />
        </span>
      ) : null}
    </span>
  )
}

/** Row actions: preview (primary, also opens from the row) and reprint. */
function InvoiceActions({
  invoice,
  onPreview,
  onPrint,
}: {
  readonly invoice: InvoiceRow
  readonly onPreview: (invoice: InvoiceRow) => void
  readonly onPrint: (invoice: InvoiceRow) => void
}) {
  const { t } = useTranslation()
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={`${t('print.preview')} — #${invoice.invoice_no}`}
        title={t('print.preview')}
        onClick={(event) => {
          event.stopPropagation()
          onPreview(invoice)
        }}
      >
        <Eye size={16} aria-hidden />
        {t('print.preview')}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`${t('app.print')} — #${invoice.invoice_no}`}
        title={t('app.print')}
        onClick={(event) => {
          event.stopPropagation()
          onPrint(invoice)
        }}
      >
        <Printer size={16} aria-hidden />
        {t('app.print')}
      </Button>
    </span>
  )
}
