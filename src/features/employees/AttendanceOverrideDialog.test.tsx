/**
 * The manager override dialog.
 *
 * The assertions are about what a manager is SHOWN and what the service is
 * ASKED for, because the boundary itself lives in Rust:
 *
 *  - both current values are on screen before anything is typed, so the change is
 *    always made against a visible "from";
 *  - the form states that this is an administrative adjustment and that it skips
 *    the automatic rounding — a manager correcting a rounding MUST be told the
 *    correction is not itself rounded;
 *  - nothing is sent until the explicit confirm, and never with a rounded or
 *    invented time: `09:07` and `18:33` go to the backend exactly as typed;
 *  - a refusal from the service is reported, not swallowed, and the dialog stays
 *    open with the draft intact.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import { AttendanceOverrideDialog } from './AttendanceOverrideDialog'
import type { AttendanceDay } from '@/services/employeesApi'

const mocks = vi.hoisted(() => ({ overrideAttendance: vi.fn() }))

vi.mock('@/services/employeesApi', () => ({
  employeesApi: { overrideAttendance: mocks.overrideAttendance },
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

/** 09:10 -> 18:20 in Africa/Cairo, the day's real values. */
const DAY: AttendanceDay = {
  id: 4,
  employee_id: 9,
  business_date: '2026-09-27',
  state: 'PRESENT',
  check_in_actual_at: '2026-09-27 06:13:00Z',
  check_in_effective_at: '2026-09-27 06:10:00Z',
  check_out_actual_at: '2026-09-27 15:16:00Z',
  check_out_effective_at: '2026-09-27 15:20:00Z',
  worked_minutes: 550,
  shift_id: null,
  recorded_by_user_id: 3,
  recorded_by_name: 'أحمد',
  note: null,
}

function open() {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(
    <ToastProvider>
      <AttendanceOverrideDialog day={DAY} onClose={onClose} onSaved={onSaved} />
    </ToastProvider>,
  )
  return { onClose, onSaved }
}

/** The two time inputs, in the order the dialog lays them out. */
function fields() {
  return screen.getAllByDisplayValue(/^\d{2}:\d{2}$/) as HTMLInputElement[]
}

const confirm = () => screen.getByRole('button', { name: i18n.t('employees.override.confirm') })

describe('AttendanceOverrideDialog', () => {
  beforeEach(() => {
    mocks.overrideAttendance.mockReset().mockResolvedValue(DAY)
  })

  it('shows both current values before anything is edited', () => {
    open()
    // 06:10Z / 15:20Z are 09:10 and 18:20 at the café.
    expect(screen.getByText('09:10')).toBeInTheDocument()
    expect(screen.getByText('18:20')).toBeInTheDocument()
    // And the fields open on exactly those values, pre-filled for the edit.
    expect(fields().map((input) => input.value)).toEqual(['09:10', '18:20'])
  })

  it('states that this is an administrative adjustment, exempt from the rounding', () => {
    open()
    // The one sentence a manager must read before typing: the correction itself
    // is NOT snapped onto the ten-minute grid.
    expect(screen.getByText(i18n.t('employees.override.adminNote'))).toBeInTheDocument()
  })

  it('sends nothing until the confirmation, then sends the exact times typed', async () => {
    const { onClose, onSaved } = open()
    // Off the grid on purpose, and BOTH directions: earlier check-in, later
    // check-out.
    fireEvent.change(fields()[0], { target: { value: '09:07' } })
    fireEvent.change(fields()[1], { target: { value: '18:33' } })
    expect(mocks.overrideAttendance).not.toHaveBeenCalled()

    fireEvent.click(confirm())

    await waitFor(() =>
      expect(mocks.overrideAttendance).toHaveBeenCalledWith(9, '2026-09-27', {
        check_in: '09:07',
        check_out: '18:33',
        reason: '',
      }),
    )
    // A successful correction closes the dialog and asks the caller to refresh.
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSaved).toHaveBeenCalled()
  })

  it('lets a single side be corrected and leaves the other one to the service', async () => {
    open()
    fireEvent.change(fields()[0], { target: { value: '09:00' } })
    fireEvent.click(confirm())

    await waitFor(() =>
      // The untouched side is null — "keep it exactly as it is" — and never a
      // re-statement of the value already on screen.
      expect(mocks.overrideAttendance).toHaveBeenCalledWith(9, '2026-09-27', {
        check_in: '09:00',
        check_out: null,
        reason: '',
      }),
    )
  })

  it('will not offer to send a check-out that is not after the check-in', () => {
    open()
    fireEvent.change(fields()[1], { target: { value: '08:00' } })
    expect(confirm()).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('employees.override.invalidPair'))
  })

  it('will not offer to send an untouched pair', () => {
    open()
    // Both values arrive correct; there is nothing to correct yet.
    expect(confirm()).toBeDisabled()
    expect(screen.getByText(i18n.t('employees.override.unchanged'))).toBeInTheDocument()
  })

  it('reports a refusal and keeps the draft, never swallowing it', async () => {
    mocks.overrideAttendance.mockRejectedValue({ kind: 'business_rule', message: 'auth.forbidden' })
    const { onClose } = open()
    fireEvent.change(fields()[0], { target: { value: '09:00' } })
    fireEvent.click(confirm())

    await waitFor(() => expect(screen.getByText(/صلاحية/)).toBeInTheDocument())
    // The dialog stays open with the correction still in it, so a refused
    // override never costs the manager their typing.
    expect(onClose).not.toHaveBeenCalled()
    expect(fields()[0].value).toBe('09:00')
  })

  it('cancels without sending anything', () => {
    const { onClose } = open()
    fireEvent.change(fields()[0], { target: { value: '09:00' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('app.cancel') }))
    expect(onClose).toHaveBeenCalled()
    expect(mocks.overrideAttendance).not.toHaveBeenCalled()
  })
})
