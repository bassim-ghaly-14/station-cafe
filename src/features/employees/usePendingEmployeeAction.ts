/**
 * The SINGLE gate for every state-changing action on the employees page.
 *
 * One confirmation at a time, one executor, and the confirmation copy derived
 * from the very same pending value the executor reads — so a dialog can never
 * show one sentence and perform another. Attendance, employment status and the
 * permanent delete all differ in the sentence they speak and in the request they
 * send; they do not differ in the discipline, which is why the discipline lives
 * here once and the differences are a lookup on the action's kind.
 */
import { useMemo, useState } from 'react'
import type { TFunction } from 'i18next'

import { useToast } from '@/components/ui'
import { useErrText } from '@/lib/err'
import { employeesApi } from '@/services/employeesApi'
import type { AttendanceAction, EmployeeRow } from '@/services/employeesApi'

/**
 * The action a confirmation is pending for, or `null` when nothing is pending.
 *
 * Nothing is executed on the click that OPENS the dialog — the click only records
 * the intent, and the request is sent from the confirm handler. That is the whole
 * point: an attendance day and an employment status are both facts other people
 * are paid from, so neither may change from a single click.
 */
export type PendingAction =
  | { kind: 'attendance'; employee: EmployeeRow; action: AttendanceAction }
  | { kind: 'status'; employee: EmployeeRow; next: 'ACTIVE' | 'INACTIVE' }
  | { kind: 'delete'; employee: EmployeeRow }
  | null

export interface EmployeeConfirmation {
  readonly title: string
  readonly body: string
  readonly detail?: string
  readonly confirmLabel?: string
  readonly destructive: boolean
}

/** The attendance punch, and its consequence, in words. */
const ATTENDANCE_KEY: Record<AttendanceAction, 'checkIn' | 'checkOut' | 'absent' | 'leave'> = {
  CHECK_IN: 'checkIn',
  CHECK_OUT: 'checkOut',
  ABSENT: 'absent',
  LEAVE: 'leave',
}

const ATTENDANCE_DETAIL: Record<AttendanceAction, 'roundingHint' | 'absentDetail' | 'leaveDetail'> =
  {
    CHECK_IN: 'roundingHint',
    CHECK_OUT: 'roundingHint',
    ABSENT: 'absentDetail',
    LEAVE: 'leaveDetail',
  }

/** The confirmation COPY for the pending action, derived rather than stored. */
function describeConfirmation(t: TFunction, pending: PendingAction): EmployeeConfirmation | null {
  if (!pending) {
    return null
  }

  if (pending.kind === 'delete') {
    // The most dangerous action on the page, so it gets its own title, an
    // explicit "permanent" warning, and the only confirm label that says so.
    return {
      title: t('employees.confirm.deleteTitle'),
      body: t('employees.confirm.deleteBody', { name: pending.employee.name }),
      detail: t('employees.confirm.deleteDetail', { name: pending.employee.name }),
      confirmLabel: t('employees.confirm.deleteConfirm'),
      destructive: true,
    }
  }

  if (pending.kind === 'status') {
    const stopping = pending.next === 'INACTIVE'
    return {
      title: t('employees.confirm.title'),
      body: t(stopping ? 'employees.confirm.deactivate' : 'employees.confirm.activate', {
        name: pending.employee.name,
      }),
      // A stop is the sensitive direction, so it states the consequence and is
      // the only one rendered with a destructive confirm button.
      detail: t(
        stopping ? 'employees.confirm.deactivateDetail' : 'employees.confirm.activateDetail',
        { name: pending.employee.name },
      ),
      destructive: stopping,
    }
  }

  const { employee, action } = pending
  return {
    title: t('employees.confirm.title'),
    body: t(`employees.confirm.${ATTENDANCE_KEY[action]}`, { name: employee.name }),
    // The two punches are a moment and need no warning; absence and leave
    // close the whole day, which is the irreversible half of this surface.
    detail: t(`employees.confirm.${ATTENDANCE_DETAIL[action]}`),
    destructive: false,
  }
}

export function usePendingEmployeeAction({
  t,
  reloadList,
  reloadOverview,
  reloadMine,
}: {
  readonly t: TFunction
  /** The roster. */
  readonly reloadList: () => void
  /** The KPI band's headcount. */
  readonly reloadOverview: () => void
  /** The reader's own attendance panel. */
  readonly reloadMine: () => void
}) {
  const toast = useToast()
  const errText = useErrText(t)

  // The single pending confirmation. While it is set, no other action may start.
  const [pending, setPending] = useState<PendingAction>(null)
  const [pendingBusy, setPendingBusy] = useState(false)

  /**
   * One punch from a table row. This now only RECORDS the intent; the command
   * is sent from `confirmPending`, after the user has answered the dialog.
   */
  function record(employee: EmployeeRow, action: AttendanceAction) {
    setPending({ kind: 'attendance', employee, action })
  }

  /**
   * Stop or restart an employee. This is the deactivated / reactivated action
   * the old staff screen offered, restored on the canonical surface: the record
   * and its whole history are kept, and the backend suspends the person's login
   * in the same transaction so a stopped employee can no longer sign in.
   *
   * This is the REVERSIBLE answer and remains the right one for anybody with
   * history: the record and everything it references are kept. Permanent
   * deletion (ADMIN only) is reserved for a record with no history at all — a
   * duplicate or a mistyped entry that was never used — and is refused by the
   * backend whenever removing the person would cost a historical row.
   */
  function toggleStatus(employee: EmployeeRow) {
    setPending({
      kind: 'status',
      employee,
      next: employee.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
    })
  }

  /**
   * Permanently delete an employee. ADMIN only.
   *
   * Like every other action here this only RECORDS the intent: the request is
   * sent from `confirmPending`, after the confirmation has been answered. The
   * confirmation states that the action is permanent, because it is — the
   * backend removes the row rather than archiving it, and refuses outright for
   * anyone whose attendance, advances or payroll history would be destroyed.
   */
  function deleteEmployee(employee: EmployeeRow) {
    setPending({ kind: 'delete', employee })
  }

  /**
   * The ONLY place a pending action is actually executed.
   *
   * Ordering matters: the dialog closes first and the dialog's state is cleared
   * before the await, so a slow command cannot leave a stale confirmation on
   * screen. A refusal is reported through the existing toast and never swallowed.
   */
  async function confirmPending() {
    if (!pending) return
    const target = pending
    setPending(null)
    setPendingBusy(true)
    try {
      if (target.kind === 'attendance') {
        await employeesApi.recordAttendance(target.employee.id, target.action)
        toast(t('employees.attendance.saved'), 'success')
        // Both the roster and the personal panel change on a punch.
        reloadList()
        reloadMine()
      } else if (target.kind === 'delete') {
        await employeesApi.remove(target.employee.id)
        toast(t('employees.status.deleted', { name: target.employee.name }), 'success')
        // The roster, the KPI band's headcount and the personal attendance panel
        // all read employees, so all three are refreshed.
        reloadList()
        reloadOverview()
        reloadMine()
      } else {
        await employeesApi.setStatus(target.employee.id, target.next)
        toast(t(`employees.status.saved.${target.next}`), 'success')
        reloadList()
      }
    } catch (cause) {
      toast(errText(cause), 'error')
    } finally {
      setPendingBusy(false)
    }
  }

  const confirmation = useMemo(() => describeConfirmation(t, pending), [pending, t])

  return {
    record,
    toggleStatus,
    deleteEmployee,
    confirmPending,
    confirmation,
    pendingBusy,
    /** Nothing is pending exactly when nothing should be shown. */
    closePending: () => setPending(null),
  }
}
