/**
 * The customers table.
 *
 * Columns are decided by WHAT THE PAYLOAD CONTAINS, never by a CSS class: the
 * backend omits the aggregate entirely for a role that may not see customer
 * money, so the financial columns and the actions column are simply not built
 * for a cashier. There is no empty "Actions" cell and nothing hidden behind
 * `display: none` — a cashier's row ends where their data ends.
 *
 * The activity columns are period-scoped because they sit under a period
 * filter; the customer's own record (name, phone, plates, registration date)
 * is lifetime data and is not.
 *
 * Identity column
 * ---------------
 * The first column is the strongest thing on the row: a deterministic customer
 * avatar, the name as the heaviest text, and the phone/notes as a quiet second
 * line. The phone therefore lives INSIDE the identity cell rather than in its
 * own column — the table gets shorter, not louder.
 */
import { useTranslation } from 'react-i18next'
import {
  Badge,
  DataTable,
  DataTableCell,
  DataTableRow,
  MoneyDisplay,
  TableActionButton,
  TableActionDivider,
  TableActionGroup,
  type DataTableColumn,
} from '@/components/ui'
import { Car, Eye, Pencil, Trash2 } from '@/components/ui/icon'
import { CustomerAvatar } from '@/lib/customer-visual'
import { CustomerVehicleBadge } from './CustomerVehicleBadge'
import { DisplayDate, DisplayDateTime } from '@/components/ui/display-datetime'
import type { CustomerRow } from '@/services/customersApi'

export function CustomerTable({
  customers,
  financialVisible,
  canDelete,
  onOpenDetails,
  onEdit,
  onDelete,
  busy,
  className,
}: {
  readonly customers: CustomerRow[]
  /** From the backend payload — the same flag gates the KPI band and drawer. */
  readonly financialVisible: boolean
  /**
   * ADMIN only. The backend service re-checks the role on `delete_customer` and
   * refuses a MANAGER or CASHIER regardless of what this button offers.
   */
  readonly canDelete?: boolean
  readonly onOpenDetails: (customer: CustomerRow) => void
  readonly onEdit: (customer: CustomerRow) => void
  /** Record the delete INTENT only. The page confirms, requests and toasts. */
  readonly onDelete: (customer: CustomerRow) => void
  readonly busy?: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  const activity: DataTableColumn[] = [
    { key: 'orders', label: t('customers.columns.orders') },
    { key: 'paid', label: t('customers.columns.paid') },
    { key: 'credit', label: t('customers.columns.credit'), hideBelow: 'lg' },
    { key: 'last', label: t('customers.columns.lastActivity'), hideBelow: 'lg' },
  ]

  const columns: DataTableColumn[] = [
    {
      key: 'customer',
      label: t('customers.columns.customer'),
      headerClassName: 'min-w-56',
    },
    { key: 'cars', label: t('customers.columns.cars'), hideBelow: 'md' },
    { key: 'created', label: t('customers.columns.created'), hideBelow: 'xl' },
    // Built only when the payload actually carries the numbers.
    ...(financialVisible ? activity : []),
    ...(financialVisible
      ? [{ key: 'actions', label: t('app.actions') } satisfies DataTableColumn]
      : []),
  ]

  return (
    <DataTable
      caption={t('customers.table.caption')}
      columns={columns}
      busy={busy}
      className={className}
    >
      {customers.map((customer) => {
        const stats = financialVisible ? customer.stats : null
        return (
          <DataTableRow key={customer.id}>
            <DataTableCell>
              {/* Avatar + name + quiet secondary metadata. The avatar repeats
                  the name, so it is decorative and the name stays the single
                  source of identity. */}
              <div className="flex min-w-0 items-center gap-3">
                <CustomerAvatar id={customer.id} name={customer.name} size="sm" />
                <div className="min-w-0">
                  {/* Same weight as the employee name in the Employees roster:
                      the row's lead text is emphasised by colour and size, not
                      by a heavier weight the Employees table does not use. */}
                  <span className="block max-w-48 truncate font-medium text-foreground-strong">
                    {customer.name}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span dir="ltr" className="truncate text-caption tabular-nums">
                      {customer.phone ?? '—'}
                    </span>
                    {customer.notes ? (
                      <span className="truncate text-caption text-foreground-faint">
                        {customer.notes}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            </DataTableCell>

            <DataTableCell className="hidden md:table-cell">
              {/* One compact badge states the whole vehicle situation; the
                  plates stay as the detail underneath it, never as a count. */}
              <div className="flex flex-col items-start gap-1">
                <CustomerVehicleBadge carsCount={customer.cars_count} />
                {customer.plates.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {customer.plates.map((plate) => (
                      <span
                        key={plate}
                        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-caption"
                      >
                        <Car size={12} aria-hidden />
                        <span dir="ltr">{plate}</span>
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>
            </DataTableCell>

            <DataTableCell className="hidden xl:table-cell">
              <DisplayDate value={customer.created_at} />
            </DataTableCell>

            {financialVisible ? (
              <>
                <DataTableCell>
                  <span className="tabular-nums">{stats?.invoices_count ?? 0}</span>
                </DataTableCell>

                <DataTableCell>
                  <MoneyDisplay amount={stats?.paid ?? 0} variant="auto" />
                </DataTableCell>

                <DataTableCell className="hidden lg:table-cell">
                  {stats && stats.credit_outstanding > 0 ? (
                    <Badge variant="warning" size="sm" dot>
                      <MoneyDisplay amount={stats.credit_outstanding} variant="auto" />
                    </Badge>
                  ) : (
                    <span className="text-foreground-faint">—</span>
                  )}
                </DataTableCell>

                <DataTableCell className="hidden lg:table-cell">
                  {stats?.last_at ? (
                    <DisplayDateTime value={stats.last_at} />
                  ) : (
                    <span className="text-foreground-faint">—</span>
                  )}
                </DataTableCell>
              </>
            ) : null}

            {financialVisible ? (
              <DataTableCell>
                {/* The SAME action column the Employees roster uses — the shared
                    `TableAction*` primitives — so switching between the two
                    screens shows one control in one size with one spacing rule,
                    not two hand-rolled versions of the same idea. Read is
                    `info`, change is `warning`, and the one irreversible action
                    is `destructive` and sits last, behind a hairline. */}
                <TableActionGroup>
                  <TableActionButton
                    tone="info"
                    onClick={() => onOpenDetails(customer)}
                    aria-label={t('customers.actions.details', { name: customer.name })}
                    title={t('customers.actions.details', { name: customer.name })}
                  >
                    <Eye size={24} aria-hidden />
                  </TableActionButton>
                  <TableActionButton
                    tone="warning"
                    onClick={() => onEdit(customer)}
                    aria-label={t('customers.actions.edit', { name: customer.name })}
                    title={t('customers.actions.edit', { name: customer.name })}
                  >
                    <Pencil size={24} aria-hidden />
                  </TableActionButton>
                  {/* Permanent delete. ADMIN only, and last in the group: it is
                      the one customer action that cannot be undone. */}
                  {canDelete ? (
                    <>
                      <TableActionDivider />
                      <TableActionButton
                        tone="danger"
                        onClick={() => onDelete(customer)}
                        aria-label={t('customers.actions.delete', { name: customer.name })}
                        title={t('customers.actions.delete', { name: customer.name })}
                        data-testid="customer-row-delete"
                      >
                        <Trash2 size={24} aria-hidden />
                      </TableActionButton>
                    </>
                  ) : null}
                </TableActionGroup>
              </DataTableCell>
            ) : null}
          </DataTableRow>
        )
      })}
    </DataTable>
  )
}
