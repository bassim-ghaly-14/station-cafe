/**
 * The employees table.
 *
 * Two tables live here, and which one renders is decided by WHAT THE PAYLOAD
 * CONTAINS, never by a CSS class: the backend omits salary, notes, login role,
 * the period analytics and the performance figures for a role that may not see
 * them, so those cells are simply not built.
 *
 * - A MANAGER/ADMIN gets the HR table: identity, role, salary, status, the period
 *   attendance analytics, individual performance and every management action.
 * - A CASHIER gets an ATTENDANCE OPERATION table: identity, phone, status, TODAY's
 *   live attendance and the four attendance actions. Nothing else is constructed,
 *   and no financial figure was ever sent to that browser.
 *
 * The role column
 * ---------------
 * The badge shows the person's REAL role, taken from the row's `login_role` —
 * the linked login's `ADMIN` / `MANAGER` / `STAFF` — and a wash worker shows
 * `WASH_WORKER`, the only role a person with no login can hold. The role is
 * never derived from `employee_type`, because every login in Station is a
 * `CASHIER` employee and that would label every manager and admin "كاشير".
 *
 * `employeeRole` in `@/lib/roles` is the single place that decision is made, so
 * the table, the drawer and the avatar can never disagree about it.
 *
 * Performance
 * -----------
 * Performance is CASHIER-only and is limited to what a login genuinely owns: the
 * shifts it opened and the cafe money booked to it. A wash worker row has NO
 * performance cell at all — washing is a shared department whose revenue belongs
 * to the department, so a per-worker wash revenue figure would be a fabrication.
 *
 * Attendance
 * ----------
 * All four actions are offered to every authenticated role, because taking a
 * punch is the operation this roster exists for. They are disabled by the same
 * day-state rules the backend enforces, so a user is never offered an action that
 * is guaranteed to be refused — a convenience, not the boundary.
 *
 * Identity column
 * ---------------
 * The existing `EmployeeAvatar` treatment is reused exactly as it is, fed the
 * same real role the badge shows, so a manager keeps the manager colour, a
 * cashier the cashier colour, and a wash worker gets their own. No new avatar
 * and no new palette is introduced here.
 */
import { useTranslation } from 'react-i18next'
import {
  Badge,
  DataTable,
  DataTableCell,
  DataTableRow,
  EmployeeAvatar,
  MoneyDisplay,
  TableActionButton,
  TableActionDivider,
  TableActionGroup,
  type DataTableColumn,
} from '@/components/ui'
import { DisplayTime } from '@/components/ui/display-datetime'
// The icon set is a curated allowlist; these are the two door glyphs that read
// as "arrived" and "left", which is exactly what a punch pair means.
import {
  Coffee,
  DoorClosed,
  DoorOpen,
  Droplets,
  Eye,
  Pencil,
  Power,
  Ticket,
  Trash2,
  UserX,
} from '@/components/ui/icon'
import { attendanceAvailability, formatWorkedDuration, todayOf } from './attendance'
import { attendanceBadgeVariant } from '@/lib/status-badge'
import type { TodayFacts } from './attendance'
import { roleLabel, roleOf } from './employee-role'
import type { TFunction } from 'i18next'
import type { AttendanceAction, EmployeeRow } from '@/services/employeesApi'

/**
 * A stopped employee stays in the list and keeps every number that belongs to
 * their history — deactivation is not deletion, because their past invoices,
 * payments and reports must still resolve to them. The row is merely quieted so
 * the active roster reads first.
 */
function inactiveClass(status: string) {
  return status === 'ACTIVE' ? undefined : 'text-foreground-subtle'
}

export function EmployeeTable({
  employees,
  managementVisible,
  canDelete,
  onOpenDetails,
  onEdit,
  onRecord,
  onToggleStatus,
  onDelete,
  busy,
  className,
}: {
  readonly employees: EmployeeRow[]
  /** From the backend payload — the same flag gates the KPI band and drawer. */
  readonly managementVisible: boolean
  /**
   * ADMIN only. Hiding the affordance is NOT the boundary — the service
   * re-checks the role on `delete_employee` and refuses a MANAGER or CASHIER
   * even if this button were triggered directly.
   */
  readonly canDelete?: boolean
  readonly onOpenDetails: (employee: EmployeeRow) => void
  readonly onEdit: (employee: EmployeeRow) => void
  /** Dispatch one attendance action; the page owns the request and the toast. */
  readonly onRecord: (employee: EmployeeRow, action: AttendanceAction) => void
  /** Activate/deactivate. The page owns the request, the toast and the reload. */
  readonly onToggleStatus: (employee: EmployeeRow) => void
  /** Record the delete INTENT only. The page confirms, requests and toasts. */
  readonly onDelete: (employee: EmployeeRow) => void
  readonly busy?: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  // The cashier's roster is an ATTENDANCE OPERATION table, not a smaller HR
  // table: the columns that exist only to describe a person (their login role,
  // their salary, their period analytics, their revenue) are not merely hidden
  // for that role — they are not built at all, because the backend never sent
  // those fields. What remains is exactly what taking a punch needs.
  const columns: DataTableColumn[] = managementVisible
    ? [
        { key: 'employee', label: t('employees.columns.employee'), headerClassName: 'min-w-52' },
        { key: 'type', label: t('employees.columns.role') },
        { key: 'phone', label: t('employees.columns.phone'), hideBelow: 'md' },
        { key: 'status', label: t('employees.columns.status') },
        { key: 'attendance', label: t('employees.columns.attendance'), hideBelow: 'lg' },
        { key: 'hours', label: t('employees.columns.hours') },
        { key: 'absence', label: t('employees.columns.absence'), hideBelow: 'xl' },
        { key: 'leave', label: t('employees.columns.leave'), hideBelow: 'xl' },
        { key: 'performance', label: t('employees.columns.performance'), hideBelow: 'xl' },
        { key: 'actions', label: t('app.actions') },
      ]
    : [
        { key: 'employee', label: t('employees.columns.employee'), headerClassName: 'min-w-52' },
        { key: 'phone', label: t('employees.columns.phone'), hideBelow: 'md' },
        { key: 'status', label: t('employees.columns.status') },
        { key: 'attendance', label: t('employees.columns.today') },
        { key: 'actions', label: t('app.actions') },
      ]

  return (
    <DataTable
      caption={t('employees.table.caption')}
      columns={columns}
      busy={busy}
      className={className}
    >
      {employees.map((employee) => {
        // The REAL role, derived in exactly one place. `isCashier` still decides
        // the cashier-only performance cell, because only a login owns a shift.
        const role = roleOf(employee)
        const isCashier = employee.employee_type === 'CASHIER'
        return (
          <DataTableRow key={employee.id} className={inactiveClass(employee.status)}>
            <DataTableCell>
              <div className="flex min-w-0 items-center gap-3">
                <EmployeeAvatar role={role} />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground-strong">
                    {employee.name}
                  </span>
                </div>
              </div>
            </DataTableCell>

            {/* The role badge is MANAGEMENT information: a login role is account
                data, not attendance data, so the backend sends it as `null` for an
                attendance-only caller and the badge is not built at all. */}
            {managementVisible ? (
              <DataTableCell>
                {/* The role badge, built from the persisted login role. The
                    `role` prop hands the shared Badge its colour tokens, so the
                    badge, the avatar and the label always agree. */}
                <div className="flex flex-col items-start gap-1">
                  <Badge role={role} size="sm" dot>
                    {roleLabel(t, role)}
                  </Badge>
                  {employee.base_salary !== null ? (
                    <MoneyDisplay
                      amount={employee.base_salary}
                      variant="auto"
                      className="text-caption"
                    />
                  ) : null}
                </div>
              </DataTableCell>
            ) : null}

            <DataTableCell className="hidden md:table-cell">
              {/* Phone comes from the canonical employee record, LTR because
                  it is a number written left-to-right even in an RTL table. */}
              {employee.phone ? (
                <span dir="ltr" className="tabular-nums text-foreground-subtle">
                  {employee.phone}
                </span>
              ) : (
                <span className="text-foreground-subtle">—</span>
              )}
            </DataTableCell>

            <DataTableCell>
              {/* Active/inactive is a first-class, always-visible fact: a
                  stopped employee is muted in the row and says so in words, so
                  the state never rests on colour alone. */}
              <Badge variant={employee.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm" dot>
                {t(`employees.status.${employee.status}`)}
              </Badge>
            </DataTableCell>

            {/* The attendance cell is the one figure every role reads, and what it
                shows depends on the role: a manager sees the period total, an
                attendance-only caller sees TODAY's live state, which is the only
                history they need in order to decide what to record. */}
            {managementVisible ? (
              <DataTableCell className="hidden lg:table-cell">
                <span className="tabular-nums">{employee.attendance_days}</span>
              </DataTableCell>
            ) : null}

            {managementVisible ? (
              <DataTableCell>
                <span className="tabular-nums">
                  {formatWorkedDuration(employee.worked_minutes ?? 0, t)}
                </span>
              </DataTableCell>
            ) : (
              <DataTableCell>
                <AttendanceToday today={todayOf(employee)} t={t} />
              </DataTableCell>
            )}

            {managementVisible ? (
              <DataTableCell className="hidden xl:table-cell">
                <span className="tabular-nums">{employee.absence_days}</span>
              </DataTableCell>
            ) : null}

            {managementVisible ? (
              <DataTableCell className="hidden xl:table-cell">
                <span className="tabular-nums">{employee.leave_days}</span>
              </DataTableCell>
            ) : null}

            {/* Revenue and individual performance are management figures, so the
                cell is not built for an attendance-only caller. */}
            {managementVisible ? (
              <DataTableCell className="hidden xl:table-cell">
                {/* Only a login genuinely owns shifts and the cafe money booked to
                    them. A wash worker has no login and no personally-owned money,
                    so this cell states that instead of inventing a figure: the
                    wash department's revenue belongs to the department, and is
                    reported as such in the sales workspace. */}
                {isCashier ? (
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="flex items-center gap-1 text-caption tabular-nums text-foreground-subtle">
                      <Coffee size={12} aria-hidden />
                      {t('employees.performance.shifts', { count: employee.shifts_count ?? 0 })}
                    </span>
                    <MoneyDisplay
                      amount={employee.cafe_revenue ?? 0}
                      variant="auto"
                      className="text-caption"
                    />
                  </div>
                ) : (
                  <span className="flex items-center gap-1 text-caption text-foreground-subtle">
                    <Droplets size={12} aria-hidden />
                    {t('employees.performance.departmentRevenue')}
                  </span>
                )}
              </DataTableCell>
            ) : null}

            <DataTableCell>
              <EmployeeActions
                employee={employee}
                onRecord={onRecord}
                onOpenDetails={onOpenDetails}
                onEdit={onEdit}
                onToggleStatus={onToggleStatus}
                onDelete={onDelete}
                managementVisible={managementVisible}
                canDelete={canDelete ?? false}
              />
            </DataTableCell>
          </DataTableRow>
        )
      })}
    </DataTable>
  )
}

/**
 * TODAY's live attendance state, the one attendance fact an attendance-only
 * caller is given about a colleague.
 *
 * It states the state in words and, when the day was punched, the effective
 * times the BACKEND stored. The screen never rounds a timestamp itself: the grid
 * is a Rust rule, and a UI that computed its own would eventually disagree with
 * the payroll it is showing.
 */
function AttendanceToday({
  today,
  t,
}: Readonly<{ readonly today: TodayFacts | null; t: TFunction }>) {
  if (!today) {
    // "Not recorded" is NOT an absence — the same distinction the personal card
    // makes, and the backend has no row because nobody has written one down.
    return <span className="text-foreground-subtle">—</span>
  }
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant={attendanceBadgeVariant(today.state)} size="sm" dot>
        {t(`employees.state.${today.state}`)}
      </Badge>
      {today.check_in_effective_at ? (
        <span className="text-caption text-foreground-subtle">
          {t('employees.mine.checkedInAt')} <DisplayTime value={today.check_in_effective_at} />
        </span>
      ) : null}
    </div>
  )
}

/**
 * One row's action group.
 *
 * The two punches are the primary actions. Absence and leave sit behind a
 * hairline separator because they describe a whole day rather than a moment —
 * but they are the same operation and the same permission, so they are never
 * disabled for a role that is allowed to punch at all.
 *
 * # Icon size and the touch target
 *
 * The size, the 48px hit target and the scoped 24px glyph override are NOT
 * written here: they are the shared `TableActionGroup` / `TableActionButton`
 * primitives, extracted from this column exactly as it already was, so the
 * Customers actions column is the same control rather than a smaller copy of
 * it. The detail those primitives preserve: a Button variant sets
 * `[&_svg]:size-*`, which is a CSS rule on the CHILD and therefore beats the
 * `size` prop on the icon — so the override has to live on the group, and
 * `tailwind-merge` resolves the two `[&_svg]:size-*` rules by order, making the
 * 24px win over the variant's own 20px.
 *
 * Growing the button to 48px means the larger glyph costs no usability — the
 * hit area goes UP from 40px, not down, so the row stays comfortable to tap.
 * The group keeps `gap-1` on a single line and `justify-end` against the
 * trailing edge; the attendance actions stay directly visible rather than folded
 * into a menu, because taking a punch is the operation this table exists for.
 *
 * # Action colour
 *
 * Each action states what it does before it is pressed, using the Station
 * semantic tokens the badges already use — a punch is `success`, an absence is
 * `destructive` and a leave is `warning` (the same mapping the day-state badge
 * applies), details is `info`, edit is `warning`, the status toggle is
 * `success`/`destructive` depending on the direction it will move the employee,
 * and the irreversible delete is always `destructive`. The tone only changes
 * colour; the shape, the size and the behaviour are identical everywhere.
 *
 * # Confirmation, and what it is not
 *
 * Every state-changing button here routes through the page's single
 * `ConfirmDialog`: a click records the intent and nothing is sent until the user
 * confirms. The read-only actions (details) are not confirmed, because opening a
 * panel changes no state.
 *
 * Every button is DISABLED for the same reason the backend would refuse the
 * call — but that is a convenience, not the security boundary: the service
 * re-checks all of it regardless of what this component renders, and a direct
 * command invocation bypasses both the button and the dialog.
 */
function EmployeeActions({
  employee,
  onRecord,
  onOpenDetails,
  onEdit,
  onToggleStatus,
  onDelete,
  managementVisible,
  canDelete,
}: {
  readonly employee: EmployeeRow
  readonly onRecord: (employee: EmployeeRow, action: AttendanceAction) => void
  readonly onOpenDetails: (employee: EmployeeRow) => void
  readonly onEdit: (employee: EmployeeRow) => void
  readonly onToggleStatus: (employee: EmployeeRow) => void
  readonly onDelete: (employee: EmployeeRow) => void
  readonly managementVisible: boolean
  /** ADMIN only; the service enforces the same rule independently. */
  readonly canDelete: boolean
}) {
  const { t } = useTranslation()
  // Every authenticated role may operate attendance, so the buttons are offered
  // to every role; only the day's own state disables them.
  const availability = attendanceAvailability(employee.status === 'ACTIVE', todayOf(employee), true)
  return (
    // The 48px target, the 24px glyph override, the gaps and the semantic tones
    // all come from the shared table-action primitives, so this column and the
    // Customers one are literally the same control.
    <TableActionGroup>
      <TableActionButton
        tone="success"
        disabled={!availability.checkIn}
        onClick={() => onRecord(employee, 'CHECK_IN')}
        aria-label={t('employees.actions.checkInFor', { name: employee.name })}
        title={t('employees.actions.checkIn')}
      >
        <DoorOpen size={24} aria-hidden />
      </TableActionButton>
      <TableActionButton
        tone="success"
        disabled={!availability.checkOut}
        onClick={() => onRecord(employee, 'CHECK_OUT')}
        aria-label={t('employees.actions.checkOutFor', { name: employee.name })}
        title={t('employees.actions.checkOut')}
      >
        <DoorClosed size={24} aria-hidden />
      </TableActionButton>

      {/* A hairline, not a second row: absence and leave describe a whole day
          rather than a moment, so they read as a quieter pair. */}
      <TableActionDivider />

      <TableActionButton
        tone="danger"
        disabled={!availability.absent}
        onClick={() => onRecord(employee, 'ABSENT')}
        aria-label={t('employees.actions.absentFor', { name: employee.name })}
        title={t('employees.actions.absent')}
      >
        <UserX size={24} aria-hidden />
      </TableActionButton>
      <TableActionButton
        tone="warning"
        disabled={!availability.leave}
        onClick={() => onRecord(employee, 'LEAVE')}
        aria-label={t('employees.actions.leaveFor', { name: employee.name })}
        title={t('employees.actions.leave')}
      >
        <Ticket size={24} aria-hidden />
      </TableActionButton>

      {/* Everything below this line is management-only, so for an attendance-only
          caller the group simply ends after the four attendance actions. */}
      {managementVisible ? (
        <>
          <TableActionDivider />

          <TableActionButton
            tone="info"
            onClick={() => onOpenDetails(employee)}
            aria-label={t('employees.actions.details', { name: employee.name })}
            title={t('employees.actions.details', { name: employee.name })}
          >
            <Eye size={24} aria-hidden />
          </TableActionButton>
          <TableActionButton
            tone="warning"
            onClick={() => onEdit(employee)}
            aria-label={t('employees.actions.edit', { name: employee.name })}
            title={t('employees.actions.edit', { name: employee.name })}
          >
            <Pencil size={24} aria-hidden />
          </TableActionButton>
          {/* Deactivate / reactivate. This is a STATUS change, never a delete:
              the employee and every transaction that references them are kept.
              The backend re-checks the actor's authority (no self-deactivation,
              and only an ADMIN may stop an ADMIN) and suspends the linked login
              in the same transaction. The tone follows the DIRECTION of the
              change: stopping someone reads as destructive, restoring them as
              the success it is. */}
          <TableActionButton
            tone={employee.status === 'ACTIVE' ? 'danger' : 'success'}
            onClick={() => onToggleStatus(employee)}
            aria-label={t(
              employee.status === 'ACTIVE'
                ? 'employees.actions.deactivate'
                : 'employees.actions.activate',
              { name: employee.name },
            )}
            title={t(
              employee.status === 'ACTIVE'
                ? 'employees.actions.deactivate'
                : 'employees.actions.activate',
            )}
          >
            <Power size={24} aria-hidden />
          </TableActionButton>

          {/* Permanent delete. ADMIN only, and deliberately the LAST action in
              the group: unlike everything above it, this cannot be undone. */}
          {canDelete ? (
            <>
              <TableActionDivider />
              <TableActionButton
                tone="danger"
                onClick={() => onDelete(employee)}
                aria-label={t('employees.actions.delete', { name: employee.name })}
                title={t('employees.actions.delete', { name: employee.name })}
                data-testid="employee-row-delete"
              >
                <Trash2 size={24} aria-hidden />
              </TableActionButton>
            </>
          ) : null}
        </>
      ) : null}
    </TableActionGroup>
  )
}
