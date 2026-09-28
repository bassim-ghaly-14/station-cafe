/**
 * The day's wash tickets, as a dense table on wide screens and as full records
 * on narrow ones — the same two presentations, the same shared `DataTable`
 * shell and the same responsive rule the invoice list uses.
 *
 * Row hierarchy, in reading order:
 *   1. the WAITING NUMBER, because that is what the customer is called by and
 *      what the wash worker is holding;
 *   2. the customer and the car, then the wash services the ticket covers;
 *   3. when it was issued, through the central Station date/time formatter;
 *   4. the ORDER's status — the only status this domain actually has, so no
 *      ticket status is invented to fill the column;
 *   5. the RELATED RECEIPT, and the link that opens it.
 *
 * The receipt column is the point of the page: a ticket is issued when the
 * wash STARTS and invoiced when it LEAVES the bay, so "no receipt yet" is an
 * ordinary, expected state — it is stated in words, never rendered as a broken
 * or empty cell, and the ticket is still a first-class row.
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
import { Check, Clock, Eye, Receipt, Wallet } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import { useIsWide } from '@/lib/use-media-query'
import type { WashTicketRow } from '@/services/posApi'

/** Non-colour status cues, matching the invoice list's vocabulary. */
const STATUS_ICON: Record<string, typeof Check> = {
  CLOSED: Check,
  READY_TO_PAY: Clock,
  OPEN: Clock,
  CANCELLED: Wallet,
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'info' | 'danger'> = {
  CLOSED: 'success',
  READY_TO_PAY: 'warning',
  OPEN: 'info',
  CANCELLED: 'danger',
}

export function WashTicketList({
  rows,
  onOpenTicket,
  onOpenInvoice,
  busy = false,
}: Readonly<{
  readonly rows: readonly WashTicketRow[]
  /** Opens the ticket document through the shared print-preview dialog. */
  readonly onOpenTicket: (ticket: WashTicketRow) => void
  /** Opens the RELATED receipt — addressed by its persisted invoice id. */
  readonly onOpenInvoice: (invoiceId: number) => void
  /** A reload is running over rows that are already on screen. */
  readonly busy?: boolean
}>) {
  const { t } = useTranslation()

  const columns: DataTableColumn[] = [
    { key: 'ticket', label: t('washTicketsPage.columns.ticket'), headerClassName: 'w-40' },
    { key: 'customer', label: t('washTicketsPage.columns.customer'), hideBelow: 'lg' },
    { key: 'time', label: t('washTicketsPage.columns.time'), hideBelow: 'sm' },
    { key: 'status', label: t('washTicketsPage.columns.status'), headerClassName: 'w-32' },
    { key: 'invoice', label: t('washTicketsPage.columns.invoice'), headerClassName: 'w-44' },
    { key: 'actions', label: t('washTicketsPage.columns.actions'), headerClassName: 'w-32' },
  ]

  // Exactly ONE representation is mounted, the same rule the invoice list
  // follows: a CSS-hidden copy would still be read aloud and held twice.
  const wide = useIsWide()

  if (!wide) {
    return (
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="border-b border-border-subtle px-3 py-3 last:border-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <TicketIdentity ticket={row} />
                <TicketCustomer ticket={row} className="mt-1" />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <TicketStatus ticket={row} />
                <TicketIssuedTime ticket={row} />
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <TicketInvoice ticket={row} onOpenInvoice={onOpenInvoice} />
              <TicketActions ticket={row} onOpenTicket={onOpenTicket} />
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <DataTable caption={t('pos.todayWashTickets')} columns={columns} busy={busy}>
      {rows.map((row) => (
        <DataTableRow key={row.id} onClick={() => onOpenTicket(row)}>
          <DataTableCell>
            <TicketIdentity ticket={row} />
          </DataTableCell>
          <DataTableCell className="hidden lg:table-cell">
            <TicketCustomer ticket={row} />
          </DataTableCell>
          <DataTableCell className="hidden sm:table-cell">
            <TicketIssuedTime ticket={row} />
          </DataTableCell>
          <DataTableCell>
            <TicketStatus ticket={row} />
          </DataTableCell>
          <DataTableCell>
            <TicketInvoice ticket={row} onOpenInvoice={onOpenInvoice} />
          </DataTableCell>
          <DataTableCell>
            <TicketActions ticket={row} onOpenTicket={onOpenTicket} />
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}

/** The waiting number, with the ticket's own identifier beside it. */
function TicketIdentity({ ticket }: Readonly<{ readonly ticket: WashTicketRow }>) {
  const { t } = useTranslation()
  return (
    <span className="block min-w-0">
      <span className="block truncate text-body font-bold text-foreground-strong" dir="ltr">
        #{ticket.waiting_no}
      </span>
      <span className="mt-0.5 block truncate text-caption">
        {t('washTicketsPage.ticketLabel')} <span dir="ltr">#{ticket.id}</span>
        <span aria-hidden> · </span>
        <span>
          {t('pos.order')} <span dir="ltr">#{ticket.order_id}</span>
        </span>
      </span>
    </span>
  )
}

/** Customer, car and the wash services this ticket covers. */
function TicketCustomer({
  ticket,
  className,
}: Readonly<{ readonly ticket: WashTicketRow; readonly className?: string }>) {
  const { t } = useTranslation()
  return (
    <span className={cn('block min-w-0', className)}>
      <span className="block truncate text-sm text-foreground-muted">
        {ticket.customer_name ?? t('pos.noCustomer')}
      </span>
      {ticket.car_plate ? (
        <span className="block truncate text-xs text-foreground-subtle" dir="ltr">
          {ticket.car_plate}
          {ticket.car_model ? ` · ${ticket.car_model}` : ''}
        </span>
      ) : null}
      {ticket.services ? (
        <span className="block truncate text-xs text-foreground-subtle">{ticket.services}</span>
      ) : null}
    </span>
  )
}

/** Issue time, always through the shared Cairo/UTC formatter. */
function TicketIssuedTime({ ticket }: Readonly<{ readonly ticket: WashTicketRow }>) {
  return (
    <DisplayDateTime
      value={ticket.issued_at}
      className="text-sm text-foreground-muted"
      separator=""
      stack
    />
  )
}

/** The ORDER's status, as a badge with a dot AND an icon. */
function TicketStatus({ ticket }: Readonly<{ readonly ticket: WashTicketRow }>) {
  const { t } = useTranslation()
  return (
    <Badge
      variant={STATUS_VARIANT[ticket.order_status] ?? 'info'}
      size="sm"
      dot
      icon={STATUS_ICON[ticket.order_status]}
    >
      {t(`washTicketsPage.orderStatus.${ticket.order_status}`)}
    </Badge>
  )
}

/**
 * The related receipt, and the way into it.
 *
 * The link is addressed by `invoice_id` — the id the backend resolved through
 * the persisted `invoices.order_id` relation — so opening it reuses the ONE
 * existing invoice preview. A ticket with no receipt yet says so in words and
 * offers nothing to click, because there is genuinely nothing to open.
 */
function TicketInvoice({
  ticket,
  onOpenInvoice,
}: Readonly<{
  readonly ticket: WashTicketRow
  readonly onOpenInvoice: (invoiceId: number) => void
}>) {
  const { t } = useTranslation()
  if (ticket.invoice_id === null) {
    return (
      <span className="block min-w-0 text-xs text-foreground-subtle">
        {t('washTicketsPage.noInvoice')}
      </span>
    )
  }
  return (
    <span className="block min-w-0">
      <span className="block truncate text-body font-bold text-foreground-strong" dir="ltr">
        #{ticket.invoice_no}
      </span>
      <MoneyDisplay amount={ticket.invoice_total ?? 0} className="block text-caption" />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="-ms-2 mt-0.5"
        aria-label={`${t('print.preview')} — #${ticket.invoice_no}`}
        onClick={(event) => {
          event.stopPropagation()
          onOpenInvoice(ticket.invoice_id as number)
        }}
      >
        <Receipt size={15} aria-hidden />
        {t('print.preview')}
      </Button>
    </span>
  )
}

/** Row action: preview the ticket document itself. */
function TicketActions({
  ticket,
  onOpenTicket,
}: Readonly<{
  readonly ticket: WashTicketRow
  readonly onOpenTicket: (ticket: WashTicketRow) => void
}>) {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={`${t('pos.ticketPreview')} — ${t('washTicketsPage.waitingNumber')} #${ticket.waiting_no}`}
      title={t('pos.ticketPreview')}
      onClick={(event) => {
        event.stopPropagation()
        onOpenTicket(ticket)
      }}
    >
      <Eye size={16} aria-hidden />
      {t('pos.ticketPreview')}
    </Button>
  )
}
