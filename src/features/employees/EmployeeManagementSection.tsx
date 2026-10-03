/**
 * The MANAGEMENT section of the Employees page — ADMIN and MANAGER, on their own.
 *
 * # Why these people are separated
 *
 * Mixing an account of authority in with the operational roster told the reader
 * nothing: a manager scanning "who works here" cannot tell which rows can open
 * the till as an administrator, change somebody's salary, or load a dataset. So
 * the two questions the page answers now get two sections: "who runs this place"
 * above, "who works here" below.
 *
 * # It is a different KIND of thing, so it is a different SHAPE
 *
 * There are a handful of management accounts and dozens of staff, and what a
 * manager needs about the first is ACCOUNT information — role, status, contact,
 * salary — not the per-employee analytics grid. So this section is a card grid
 * rather than a table: it states the role and the status in words, keeps every
 * action one tap away, and stays legible on a phone where a nine-column table
 * does not.
 *
 * Everything it uses — `Card`, `Badge`, `EmployeeAvatar`, `ActionMenu`, the role
 * badge convention, the status badge, the tone vocabulary — is the existing
 * design system, so the section reads as part of Station rather than as a
 * separate product. What changed is the STRUCTURE and the emphasis, not the
 * visual language.
 *
 * # It is not a filter toggle
 *
 * Both sections are always present, each with its own count, and the split comes
 * from `partitionByManagement` over the ONE list the backend returned — so the
 * two can never disagree about who is in them, and a search narrows both at once
 * because it narrows the single list they are cut from.
 */
import { useTranslation } from 'react-i18next'
import {
  ActionMenu,
  Badge,
  Button,
  Card,
  CardHeader,
  EmployeeAvatar,
  MoneyDisplay,
  type ActionMenuItem,
} from '@/components/ui'
import { Eye, Pencil, Power, Trash2 } from '@/components/ui/icon'
import type { AttendanceAction, EmployeeRow } from '@/services/employeesApi'
import { attendanceAvailability, todayOf, useWorkDurationFormatter } from './attendance'
import { roleLabel, roleOf } from './employee-role'

export function EmployeeManagementSection({
  employees,
  canDelete,
  searching,
  onOpenDetails,
  onEdit,
  onRecord,
  onToggleStatus,
  onDelete,
}: {
  readonly employees: EmployeeRow[]
  readonly canDelete: boolean
  readonly searching: boolean
  readonly onOpenDetails: (employee: EmployeeRow) => void
  readonly onEdit: (employee: EmployeeRow) => void
  readonly onRecord: (employee: EmployeeRow, action: AttendanceAction) => void
  readonly onToggleStatus: (employee: EmployeeRow) => void
  readonly onDelete: (employee: EmployeeRow) => void
}) {
  const { t } = useTranslation()
  const formatDuration = useWorkDurationFormatter()

  // An empty management section is a NORMAL state — a café with no separate
  // manager — so it renders one short line rather than an alarming empty state.
  if (employees.length === 0) {
    return (
      <Card data-testid="employee-management-section">
        <CardHeader title={t('employees.management.title')} />
        <p className="text-sm text-foreground-muted">
          {searching ? t('employees.management.emptySearching') : t('employees.management.empty')}
        </p>
      </Card>
    )
  }

  return (
    <section
      aria-labelledby="employee-management-title"
      data-testid="employee-management-section"
      className="flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="employee-management-title" className="text-base font-bold text-foreground-strong">
          {t('employees.management.title')}
        </h2>
        {/* The count is the SECTION's own, not the page's: after the split these
            are two different numbers, and showing the total on both would be
            exactly the miscount this separation is meant to remove. */}
        <span className="text-caption tabular-nums text-foreground-subtle">
          {t('employees.states.count', { count: employees.length })}
        </span>
      </div>
      <p className="text-caption text-foreground-subtle">{t('employees.management.subtitle')}</p>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {employees.map((employee) => (
          <ManagementCard
            key={employee.id}
            employee={employee}
            canDelete={canDelete}
            formatDuration={formatDuration}
            onOpenDetails={onOpenDetails}
            onEdit={onEdit}
            onRecord={onRecord}
            onToggleStatus={onToggleStatus}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * The account facts under a management card's identity.
 *
 * Split out only because it is the one part that is about DATA rather than
 * actions. A field the backend did not send is NOT rendered as a zero: an
 * attendance-only caller receives `null` for salary and worked minutes, and
 * inventing a figure there would put a number on screen that the server never
 * sent.
 */
function ManagementFacts({
  employee,
  formatDuration,
}: {
  readonly employee: EmployeeRow
  readonly formatDuration: (minutes: number) => string
}) {
  const { t } = useTranslation()
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-caption">
      {employee.phone ? (
        <div className="flex min-w-0 flex-col">
          <dt className="text-foreground-subtle">{t('employees.columns.phone')}</dt>
          <dd className="truncate tabular-nums text-foreground-muted">{employee.phone}</dd>
        </div>
      ) : null}

      {employee.base_salary !== null ? (
        <div className="flex min-w-0 flex-col">
          <dt className="text-foreground-subtle">{t('employees.drawer.baseSalary')}</dt>
          <dd className="text-foreground-muted">
            <MoneyDisplay amount={employee.base_salary} variant="auto" />
          </dd>
        </div>
      ) : null}

      {employee.worked_minutes !== null ? (
        <div className="flex min-w-0 flex-col">
          <dt className="text-foreground-subtle">{t('employees.columns.hours')}</dt>
          {/* The ONE shared formatter, so this figure follows the Dev Settings
              display mode like every other duration on the page. */}
          <dd className="tabular-nums text-foreground-muted">
            {formatDuration(employee.worked_minutes)}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}
/**
 * One management account.
 *
 * The actions are the SAME set the roster row offers, dispatched through the
 * shared `ActionMenu` with the same tones and behind the same confirmation
 * dialog. Separating the section must not separate the abilities: a manager who
 * can edit somebody in the table can edit them here, and the service re-checks
 * authority on every one regardless.
 */
function ManagementCard({
  employee,
  canDelete,
  formatDuration,
  onOpenDetails,
  onEdit,
  onRecord,
  onToggleStatus,
  onDelete,
}: {
  readonly employee: EmployeeRow
  readonly canDelete: boolean
  readonly formatDuration: (minutes: number) => string
  readonly onOpenDetails: (employee: EmployeeRow) => void
  readonly onEdit: (employee: EmployeeRow) => void
  readonly onRecord: (employee: EmployeeRow, action: AttendanceAction) => void
  readonly onToggleStatus: (employee: EmployeeRow) => void
  readonly onDelete: (employee: EmployeeRow) => void
}) {
  const { t } = useTranslation()
  const role = roleOf(employee)
  // Punches obey the SAME day-state rules the roster row uses, so a card never
  // offers an action the backend is guaranteed to refuse.
  const availability = attendanceAvailability(employee.status === 'ACTIVE', todayOf(employee), true)

  const items: ActionMenuItem[] = [
    {
      key: 'details',
      label: t('employees.actions.details', { name: employee.name }),
      icon: <Eye size={20} aria-hidden />,
      tone: 'info',
      onClick: () => onOpenDetails(employee),
    },
    {
      key: 'edit',
      label: t('employees.actions.edit', { name: employee.name }),
      icon: <Pencil size={20} aria-hidden />,
      tone: 'warning',
      onClick: () => onEdit(employee),
    },
    {
      key: 'status',
      label:
        employee.status === 'ACTIVE'
          ? t('employees.actions.deactivate', { name: employee.name })
          : t('employees.actions.activate', { name: employee.name }),
      icon: <Power size={20} aria-hidden />,
      // The tone follows the DIRECTION of the change, exactly as the roster row
      // does: stopping someone reads as destructive, restoring them as success.
      tone: employee.status === 'ACTIVE' ? 'danger' : 'success',
      onClick: () => onToggleStatus(employee),
    },
  ]

  // Permanent delete stays ADMIN-only, and stays the LAST entry.
  if (canDelete) {
    items.push({
      key: 'delete',
      label: t('employees.actions.delete', { name: employee.name }),
      icon: <Trash2 size={20} aria-hidden />,
      tone: 'danger',
      onClick: () => onDelete(employee),
      testId: 'employee-row-delete',
    })
  }

  return (
    <li>
      <Card className="flex h-full flex-col gap-3 border-border-strong p-4">
        <div className="flex items-start gap-3">
          {/* The existing avatar, fed the same real role the badge shows. */}
          <EmployeeAvatar role={role} size="lg" />

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-body font-bold text-foreground-strong">
              {employee.name}
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              {/* The role badge keeps the SHARED role colouring, so a manager
                  looks like a manager here exactly as in the roster and in the
                  login cards. What marks this section as management is its
                  STRUCTURE and placement, not a private palette that would then
                  disagree with the one the rest of the app uses. */}
              <Badge
                variant={role === 'ADMIN' ? 'info' : 'brand'}
                size="sm"
                data-testid={`employee-management-role-${employee.id}`}
              >
                {roleLabel(t, role)}
              </Badge>
              <Badge variant={employee.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm" dot>
                {t(`employees.status.${employee.status}`)}
              </Badge>
            </div>
          </div>
        </div>

        <ManagementFacts employee={employee} formatDuration={formatDuration} />

        <div className="mt-auto flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!availability.checkIn}
            onClick={() => onRecord(employee, 'CHECK_IN')}
            aria-label={t('employees.actions.checkInFor', { name: employee.name })}
          >
            {t('employees.actions.checkIn')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!availability.checkOut}
            onClick={() => onRecord(employee, 'CHECK_OUT')}
            aria-label={t('employees.actions.checkOutFor', { name: employee.name })}
          >
            {t('employees.actions.checkOut')}
          </Button>
          <ActionMenu items={items} label={`${t('app.moreActions')}: ${employee.name}`} />
        </div>
      </Card>
    </li>
  )
}
