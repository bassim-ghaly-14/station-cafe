/**
 * The invoice activity list — the drill-down behind every figure on the page.
 *
 * It replaces the old "مبيعات اليوم" table with a management view: a manager
 * needs to see WHICH invoices produced the numbers, with the money fields that
 * reconcile with the KPI band (discount, service charge, total) and the context
 * that explains them (cashier, customer, method, status).
 *
 * Selecting a row opens the EXISTING invoice preview — the same shared
 * `PrintPreviewDialog` the POS, the invoices page and the reports page all use.
 * There is no second invoice-detail implementation in this feature.
 *
 * The list is a `DataTable`, so it keeps real table semantics, a sticky header
 * and controlled horizontal scrolling on narrow windows, and its low-priority
 * columns drop out below their breakpoint instead of squeezing the money
 * columns.
 */
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  DataTable,
  DataTableCell,
  DataTableRow,
  MoneyDisplay,
} from '@/components/ui'
import { DisplayDateTime, EmployeeAvatar, type DataTableColumn } from '@/components/ui'
import { Eye } from '@/components/ui/icon'
import { invoiceBadgeVariant } from '@/lib/status-badge'
import type { SalesInvoiceRow } from '@/services/salesApi'

export function SalesInvoiceTable({
  invoices,
  onOpen,
  busy,
  className,
}: {
  readonly invoices: SalesInvoiceRow[]
  readonly onOpen: (invoice: SalesInvoiceRow) => void
  /** A refresh is running over rows that are already on screen. */
  readonly busy?: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  const columns: DataTableColumn[] = [
    { key: 'invoice', label: t('sales.invoices.columns.invoice'), headerClassName: 'w-32' },
    { key: 'customer', label: t('sales.invoices.columns.customer'), headerClassName: 'min-w-40' },
    { key: 'cashier', label: t('sales.invoices.columns.cashier'), hideBelow: 'lg' },
    { key: 'time', label: t('sales.invoices.columns.time'), hideBelow: 'sm' },
    { key: 'status', label: t('sales.invoices.columns.status'), headerClassName: 'w-28' },
    { key: 'discount', label: t('sales.invoices.columns.discount'), hideBelow: 'xl' },
    { key: 'service', label: t('sales.invoices.columns.service'), hideBelow: 'xl' },
    { key: 'total', label: t('sales.invoices.columns.total'), headerClassName: 'w-32' },
    { key: 'actions', label: t('app.actions'), headerClassName: 'w-20' },
  ]

  return (
    <DataTable
      caption={t('sales.invoices.caption')}
      columns={columns}
      busy={busy}
      className={className}
    >
      {invoices.map((invoice) => (
        <DataTableRow key={invoice.id} onClick={() => onOpen(invoice)}>
          <DataTableCell>
            <span className="flex flex-col">
              <span className="font-bold tabular-nums text-foreground-strong">
                #{invoice.invoice_no}
              </span>
              {/* The order context as quiet second-line information. */}
              <span className="text-caption text-foreground-subtle">
                {invoice.order_type === 'TAKEAWAY'
                  ? typeof invoice.takeaway_no === 'number'
                    ? `TW-${invoice.takeaway_no}`
                    : t('pos.orderType.TAKEAWAY')
                  : (invoice.table_label ?? t('pos.orderType.TABLE'))}
              </span>
            </span>
          </DataTableCell>

          <DataTableCell>
            <span className="block max-w-48 truncate text-foreground-muted">
              {invoice.customer_name ?? t('pos.noCustomer')}
            </span>
            {invoice.car_plate ? (
              <span className="block text-caption text-foreground-subtle" dir="ltr">
                {invoice.car_plate}
              </span>
            ) : null}
          </DataTableCell>

          <DataTableCell className="hidden lg:table-cell">
            {invoice.user_name ? (
              <span className="flex items-center gap-2">
                <EmployeeAvatar role={invoice.user_role} size="sm" />
                <span className="max-w-32 truncate text-foreground-muted">{invoice.user_name}</span>
              </span>
            ) : (
              <span className="text-foreground-faint">—</span>
            )}
          </DataTableCell>

          <DataTableCell className="hidden sm:table-cell">
            <DisplayDateTime value={invoice.created_at} />
          </DataTableCell>

          <DataTableCell>
            <Badge variant={invoiceBadgeVariant(invoice.status)} size="sm" dot>
              {t(`invoice.status.${invoice.status}`)}
            </Badge>
            {invoice.payment_method ? (
              <span className="mt-1 block text-caption text-foreground-subtle">
                {t(`pay.method.${invoice.payment_method}`)}
              </span>
            ) : null}
          </DataTableCell>

          <DataTableCell className="hidden xl:table-cell">
            {invoice.discount_minor > 0 ? (
              <MoneyDisplay
                amount={-invoice.discount_minor}
                variant="auto"
                className="text-foreground-muted"
              />
            ) : (
              <span className="text-foreground-faint">—</span>
            )}
          </DataTableCell>

          <DataTableCell className="hidden xl:table-cell">
            {invoice.service_charge > 0 ? (
              <MoneyDisplay
                amount={invoice.service_charge}
                variant="auto"
                className="text-foreground-muted"
              />
            ) : (
              <span className="text-foreground-faint">—</span>
            )}
          </DataTableCell>

          <DataTableCell>
            <MoneyDisplay
              amount={invoice.total}
              variant="auto"
              className="font-bold text-money text-foreground-strong"
            />
            {invoice.paid_amount !== invoice.total ? (
              <span className="mt-0.5 block text-caption text-foreground-subtle">
                {t('invoicesPage.settledLabel')}{' '}
                <MoneyDisplay amount={invoice.paid_amount} variant="auto" className="font-bold" />
              </span>
            ) : null}
          </DataTableCell>

          <DataTableCell>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('sales.invoices.open', { no: invoice.invoice_no })}
              title={t('sales.invoices.open', { no: invoice.invoice_no })}
              onClick={(event) => {
                event.stopPropagation()
                onOpen(invoice)
              }}
            >
              <Eye size={16} aria-hidden />
            </Button>
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}
