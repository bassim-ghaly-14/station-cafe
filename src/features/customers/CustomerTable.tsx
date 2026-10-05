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
  ActionMenu,
  Badge,
  CopyButton,
  DataTable,
  DataTableCell,
  DataTableRow,
  MoneyDisplay,
  RecordList,
  RecordListActions,
  RecordListItem,
  TableActionButton,
  TableActionDivider,
  TableActionGroup,
  type ActionMenuItem,
  type DataTableColumn,
} from '@/components/ui'
import { Car, Eye, Pencil, Trash2 } from '@/components/ui/icon'
import { CustomerAvatar } from '@/lib/customer-visual'
import { CustomerVehicleBadge } from './CustomerVehicleBadge'
import { DisplayDate, DisplayDateTime } from '@/components/ui/display-datetime'
import { useIsWide } from '@/lib/use-media-query'
import type { CustomerRow } from '@/services/customersApi'

/**
 * The PHONE presentation of the customers list: one record per customer.
 *
 * It states the row's own values in the row's own order — identity, vehicles,
 * lifetime date, the period figures the role is given, then the actions — and
 * drops nothing. Two decisions are worth stating:
 *
 *  - DETAILS and EDIT stay directly visible. They are the two things a manager
 *    does with a customer most of the time, and two 48px targets fit a 296px
 *    record with room to spare, so there is no reason to charge an extra tap.
 *  - The permanent DELETE moves behind the overflow menu. It is irreversible,
 *    it is ADMIN-only, and separating it from the reversible actions is the
 *    same separation the desktop column draws with its hairline — on a phone
 *    where the two would sit side by side, that hairline is not enough.
 */
function CustomerRecordList({
  customers,
  financialVisible,
  canDelete,
  selectable,
  selectedIds,
  onToggleSelect,
  onToggleSelectVisible,
  onOpenDetails,
  onEdit,
  onDelete,
  className,
}: {
  readonly customers: readonly CustomerRow[]
  readonly financialVisible: boolean
  readonly canDelete: boolean
  readonly selectable?: boolean
  readonly selectedIds?: ReadonlySet<number>
  readonly onToggleSelect?: (customer: CustomerRow) => void
  readonly onToggleSelectVisible?: (checked: boolean) => void
  readonly onOpenDetails: (customer: CustomerRow) => void
  readonly onEdit: (customer: CustomerRow) => void
  readonly onDelete: (customer: CustomerRow) => void
  readonly className?: string
}) {
  const { t } = useTranslation()

  return (
    <RecordList className={className} aria-label={t('customers.table.caption')}>
      {selectable ? (
        <RecordListItem>
          <label className="flex cursor-pointer items-center gap-2 text-body">
            <input
              type="checkbox"
              checked={
                customers.length > 0 &&
                customers.every((row) => selectedIds?.has(row.id) ?? false)
              }
              onChange={(e) => onToggleSelectVisible?.(e.target.checked)}
            />
            {t('customers.export.selectVisible')}
          </label>
        </RecordListItem>
      ) : null}
      {customers.map((customer) => {
        const stats = financialVisible ? customer.stats : null
        const menuItems: ActionMenuItem[] = canDelete
          ? [
              {
                key: 'delete',
                label: t('customers.actions.delete', { name: customer.name }),
                icon: <Trash2 size={20} aria-hidden />,
                tone: 'danger',
                onClick: () => onDelete(customer),
                testId: 'customer-row-delete',
              },
            ]
          : []

        return (
          <RecordListItem key={customer.id}>
            {selectable ? (
              <label className="mb-2 flex cursor-pointer items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={selectedIds?.has(customer.id) ?? false}
                  onChange={() => onToggleSelect?.(customer)}
                  aria-label={t('customers.export.selectCustomer', { name: customer.name })}
                />
                {t('customers.export.select')}
              </label>
            ) : null}
            <CustomerRecordIdentity customer={customer} />
            <CustomerRecordVehicles customer={customer} />
            <p className="mt-2 text-caption text-foreground-subtle">
              {t('customers.columns.created')} <DisplayDate value={customer.created_at} />
            </p>
            {financialVisible ? <CustomerRecordFigures stats={stats} /> : null}
            <RecordListActions>
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
              </TableActionGroup>
              {menuItems.length > 0 ? (
                <ActionMenu items={menuItems} label={`${t('app.moreActions')}: ${customer.name}`} />
              ) : null}
            </RecordListActions>
          </RecordListItem>
        )
      })}
    </RecordList>
  )
}

/** Identity: the deterministic avatar, the name, and the phone beneath it. */
function CustomerRecordIdentity({ customer }: { readonly customer: CustomerRow }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <CustomerAvatar id={customer.id} name={customer.name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-bold text-foreground-strong">{customer.name}</p>
          {/* The phone and its copy control travel together. The number keeps
              its own line as the primary readable text and the control sits
              beside it in a `shrink-0` inline row, so a long number truncates
              on its own and never pushes the button out of the record. */}
          <span className="mt-0.5 flex items-center gap-1">
            <span dir="ltr" className="truncate text-caption tabular-nums">
              {customer.phone ?? '—'}
            </span>
            {customer.phone ? (
              <PhoneCopyButton name={customer.name} phone={customer.phone} />
            ) : null}
          </span>
        </div>
      </div>
      {customer.notes ? (
        <p className="mt-1.5 line-clamp-2 text-caption text-foreground-faint">{customer.notes}</p>
      ) : null}
    </>
  )
}

/**
 * Copy the phone number of one person.
 *
 * This is the WHOLE Customers-side copy behaviour, and it is a two-line wrapper
 * rather than a component of its own: the actual copy interaction — the
 * clipboard write, the success state, the icon swap, the toast and the
 * accessible naming — belongs entirely to the shared `CopyButton`. What this
 * adds is only the two translated strings, so the Customers table and its phone
 * record presentation cannot spell the action differently.
 *
 * It is rendered ONLY when a phone exists. A row with no number has nothing to
 * copy, and a control that could only ever produce an empty clipboard is worse
 * than no control — the same rule the shared button follows for an origin with
 * no clipboard at all.
 */
function PhoneCopyButton({ name, phone }: { readonly name: string; readonly phone: string }) {
  const { t } = useTranslation()
  return (
    <CopyButton
      value={phone}
      label={t('customers.actions.copyPhone', { name })}
      copiedLabel={t('app.copied')}
      data-testid="customer-copy-phone"
    />
  )
}

/**
 * The vehicle situation as ONE badge plus the plates beneath it — the same
 * statement the table's column makes, so the two presentations agree on what
 * "two cars" looks like.
 */
function CustomerRecordVehicles({ customer }: { readonly customer: CustomerRow }) {
  return (
    <div className="mt-2 flex flex-col items-start gap-1">
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
  )
}

/**
 * The period figures a manager is given, at the shared type sizes. The values
 * are the backend's aggregates, read from the same `stats` the table's cells
 * read, so the two presentations can never disagree about a total.
 */
function CustomerRecordFigures({ stats }: { readonly stats: CustomerRow['stats'] | null }) {
  const { t } = useTranslation()
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <CustomerFigure label={t('customers.columns.orders')}>
        <span className="tabular-nums">{stats?.invoices_count ?? 0}</span>
      </CustomerFigure>
      <CustomerFigure label={t('customers.columns.paid')}>
        <MoneyDisplay amount={stats?.paid ?? 0} variant="auto" />
      </CustomerFigure>
      <CustomerFigure label={t('customers.columns.credit')}>
        {stats && stats.credit_outstanding > 0 ? (
          <MoneyDisplay amount={stats.credit_outstanding} variant="auto" />
        ) : (
          '—'
        )}
      </CustomerFigure>
      <CustomerFigure label={t('customers.columns.lastActivity')}>
        {stats?.last_at ? <DisplayDateTime value={stats.last_at} /> : '—'}
      </CustomerFigure>
    </div>
  )
}

/** A labelled figure inside a customer record, at the shared type sizes. */
function CustomerFigure({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-caption text-foreground-subtle">{label}</span>
      <span className="text-body font-bold tabular-nums text-foreground-strong">{children}</span>
    </span>
  )
}

export function CustomerTable({
  customers,
  financialVisible,
  canDelete,
  selectable,
  selectedIds,
  onToggleSelect,
  onToggleSelectVisible,
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
  /** When true, each row offers a checkbox for the phone export selection. */
  readonly selectable?: boolean
  readonly selectedIds?: ReadonlySet<number>
  readonly onToggleSelect?: (customer: CustomerRow) => void
  /** Check/uncheck every VISIBLE row. "All customers" export stays server-side. */
  readonly onToggleSelectVisible?: (checked: boolean) => void
  readonly onOpenDetails: (customer: CustomerRow) => void
  readonly onEdit: (customer: CustomerRow) => void
  /** Record the delete INTENT only. The page confirms, requests and toasts. */
  readonly onDelete: (customer: CustomerRow) => void
  readonly busy?: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  /*
   * The same two-presentation rule the Employees roster follows, for the same
   * reason and with the same shared breakpoint: at `md` and up this is the
   * table, and below it the same data is a record per customer. This table is
   * lighter than the roster — three columns survive at 360px — but its ACTIONS
   * still need 144px of a 296px record, and the customer's name and their money
   * cannot both stay on screen beside a horizontal scroller. Exactly one of the
   * two presentations is mounted.
   */
  const wide = useIsWide()

  const activity: DataTableColumn[] = [
    { key: 'orders', label: t('customers.columns.orders') },
    { key: 'paid', label: t('customers.columns.paid') },
    { key: 'credit', label: t('customers.columns.credit'), hideBelow: 'lg' },
    { key: 'last', label: t('customers.columns.lastActivity'), hideBelow: 'lg' },
  ]

  const columns: DataTableColumn[] = [
    // Selection is the FIRST column so the checkbox leads the row in both
    // directions. Its header cell stays blank: the labeled "select visible"
    // control sits directly above the table, so header text would repeat it.
    ...(selectable
      ? [
          {
            key: 'select',
            label: '',
            headerClassName: 'w-10',
          } satisfies DataTableColumn,
        ]
      : []),
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

  if (!wide) {
    return (
      <CustomerRecordList
        customers={customers}
        financialVisible={financialVisible}
        canDelete={canDelete ?? false}
        selectable={selectable}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onToggleSelectVisible={onToggleSelectVisible}
        onOpenDetails={onOpenDetails}
        onEdit={onEdit}
        onDelete={onDelete}
        className={className}
      />
    )
  }

  // Header checkbox state is derived from the VISIBLE rows only: "all" here
  // means "all visible", never the whole database.
  const visibleIds = customers.map((row) => row.id)
  const visibleSelected = visibleIds.filter((id) => selectedIds?.has(id)).length
  const allVisibleChecked = visibleIds.length > 0 && visibleSelected === visibleIds.length

  return (
    <>
      {selectable ? (
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-body">
            <input
              type="checkbox"
              checked={allVisibleChecked}
              onChange={(e) => onToggleSelectVisible?.(e.target.checked)}
            />
            {t('customers.export.selectVisible')}
          </label>
        </div>
      ) : null}
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
            {selectable ? (
              <DataTableCell>
                <input
                  type="checkbox"
                  checked={selectedIds?.has(customer.id) ?? false}
                  onChange={() => onToggleSelect?.(customer)}
                  aria-label={t('customers.export.selectCustomer', { name: customer.name })}
                />
              </DataTableCell>
            ) : null}
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
                    {/* The copy control belongs to the PHONE, not to the cell:
                        it is rendered only when there is a phone to copy, and
                        it sits immediately beside the number so the association
                        is unambiguous. `shrink-0` keeps it from being squeezed
                        by a long number. */}
                    {customer.phone ? (
                      <PhoneCopyButton name={customer.name} phone={customer.phone} />
                    ) : null}
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
    </>
  )
}
