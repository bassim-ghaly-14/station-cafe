/**
 * IPC contract tests for the employees attendance command.
 *
 * The single assertion that matters here is the SHAPE of the payload. Station
 * rounds an attendance timestamp exactly once, in the Rust service: the UI sends
 * an INTENT (which employee, which action) and the service reads the clock and
 * applies the business rule. If this payload ever grew a timestamp — or a
 * pre-rounded time — the backend would round a second time and the stored value
 * would drift a second grid step from the real action.
 *
 * The rounding direction and the ten-minute ceiling are asserted where they are
 * implemented, in `src-tauri/src/services/attendance.rs`. This file exists to
 * keep the frontend from ever taking that work over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { employeesApi } from './employeesApi'
import type { AttendanceAction } from './employeesApi'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}))
vi.mock('@/features/auth/session', () => ({ sessionToken: () => 'test-token' }))

/** The payload keys the attendance command is allowed to carry. */
const ALLOWED = new Set(['token', 'employee_id', 'action', 'note'])

describe('employeesApi attendance IPC contract', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({})
  })

  it('sends an intent, never a time, for every action', async () => {
    for (const action of ['CHECK_IN', 'CHECK_OUT', 'ABSENT', 'LEAVE'] as AttendanceAction[]) {
      invoke.mockClear()
      await employeesApi.recordAttendance(7, action)

      const [command, args] = invoke.mock.calls[0]
      expect(command).toBe('record_attendance')
      expect(args.employee_id).toBe(7)
      expect(args.action).toBe(action)

      // The whole point: no timestamp crosses the wire in either direction.
      // The service owns the clock and the rounding, so a UI that pre-rounded
      // could not exist even accidentally.
      expect(Object.keys(args).sort()).toEqual([...ALLOWED].filter((k) => k in args).sort())
      for (const key of Object.keys(args)) {
        expect(ALLOWED.has(key), `unexpected key ${key} on the attendance payload`).toBe(true)
      }
    }
  })

  it('never lets a caller supply the recorder, which is the session user', async () => {
    await employeesApi.recordAttendance(7, 'CHECK_IN')
    const [, args] = invoke.mock.calls[0]
    // `recorded_by_user_id` is resolved from the session in Rust; a parameter
    // here would let anyone file an event under another person's name.
    expect(args).not.toHaveProperty('recorded_by_user_id')
    expect(args).not.toHaveProperty('user_id')
  })

  it('lets the backend resolve the caller own record with no employee id', async () => {
    await employeesApi.myAttendance()
    const [command, args] = invoke.mock.calls[0]
    expect(command).toBe('my_attendance')
    expect(args.employee_id).toBeUndefined()
  })

  it('sends the manager stated wall clocks, and no actor, to the override', async () => {
    await employeesApi.overrideAttendance(7, '2026-09-27', {
      check_in: '08:00',
      check_out: ' 16:30 ',
      reason: ' تأخير ',
    })
    const [command, args] = invoke.mock.calls[0]
    expect(command).toBe('override_employee_attendance')
    expect(args.employee_id).toBe(7)
    expect(args.business_date).toBe('2026-09-27')
    // Exactly what was typed — no pre-rounding, in either direction. A UI that
    // snapped 08:07 to 08:10 would re-apply the very rule being corrected.
    expect(args.check_in).toBe('08:00')
    // Whitespace is trimmed at the edge, and a blank side becomes an explicit
    // null meaning "leave this one as it is", never a silent zero.
    expect(args.check_out).toBe('16:30')
    expect(args.reason).toBe('تأخير')
    // The overriding manager is the SESSION, exactly as for a punch.
    expect(args).not.toHaveProperty('recorded_by_user_id')
    expect(args).not.toHaveProperty('user_id')
  })

  it('never invents a time for a side the manager left blank', async () => {
    await employeesApi.overrideAttendance(7, '2026-09-27', { check_in: '08:15' })
    const [, args] = invoke.mock.calls[0]
    expect(args.check_in).toBe('08:15')
    expect(args.check_out).toBeNull()
    expect(args.reason).toBeNull()
  })
})
