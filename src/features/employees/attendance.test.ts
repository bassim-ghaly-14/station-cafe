/**
 * The attendance state machine is a SECURITY-ADJACENT piece of the UI: it
 * decides which buttons a cashier is offered. The backend re-checks every rule
 * regardless, so these tests do not prove enforcement — they prove the screen
 * never offers an action the service will refuse, and never hides a legal one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_ACTION,
  attendanceAvailability,
  formatWorkDuration,
  overrideDraftError,
  overrideDraftOf,
  overrideTimesOf,
  toTimeInputValue,
  todayOf,
  type OverrideDraft,
  type TodayFacts,
} from './attendance'
import {
  DEFAULT_FORMATTING,
  reloadFormattingPreferences,
  replaceFormattingPreferences,
  resetFormattingPreferences,
  sanitizePreferences,
  setWorkDurationSettings,
} from '@/lib/formatting'

const NOT_PUNCHED: TodayFacts = {
  state: 'PRESENT',
  check_in_effective_at: '2026-09-27 06:10:00Z',
  check_out_effective_at: null,
}

const CLOSED: TodayFacts = {
  state: 'PRESENT',
  check_in_effective_at: '2026-09-27 06:10:00Z',
  check_out_effective_at: '2026-09-27 15:20:00Z',
}

const ABSENT: TodayFacts = {
  state: 'ABSENT',
  check_in_effective_at: null,
  check_out_effective_at: null,
}

const LEAVE: TodayFacts = {
  state: 'LEAVE',
  check_in_effective_at: null,
  check_out_effective_at: null,
}

import { isManagementRole, partitionByManagement } from './employee-role'

describe('isManagementRole', () => {
  it('places ADMIN and MANAGER in management, and nobody else', () => {
    // The one decision the whole two-section page rests on.
    expect(isManagementRole('ADMIN')).toBe(true)
    expect(isManagementRole('MANAGER')).toBe(true)
    expect(isManagementRole('STAFF')).toBe(false)
    expect(isManagementRole('WASH_WORKER')).toBe(false)
  })

  it('decides from the login role, never from the employee type', () => {
    // Every login in Station is a `CASHIER` employee. A test that looked at the
    // type would file the owner and the manager under staff — the exact mistake
    // the separate section exists to prevent.
    const { management, staff } = partitionByManagement([
      { employee_type: 'CASHIER', login_role: 'ADMIN' },
      { employee_type: 'CASHIER', login_role: 'MANAGER' },
      { employee_type: 'CASHIER', login_role: 'STAFF' },
      { employee_type: 'WASH_WORKER', login_role: null },
    ])

    expect(management).toHaveLength(2)
    expect(staff).toHaveLength(2)
  })

  it('puts a wash worker — who has no login — with the staff', () => {
    const { management, staff } = partitionByManagement([
      { employee_type: 'WASH_WORKER', login_role: null },
    ])

    expect(management).toHaveLength(0)
    expect(staff).toHaveLength(1)
  })

  it('splits ONE list into two that never overlap and never lose a row', () => {
    const rows = [
      { employee_type: 'CASHIER', login_role: 'ADMIN' },
      { employee_type: 'CASHIER', login_role: 'STAFF' },
      { employee_type: 'CASHIER', login_role: 'MANAGER' },
      { employee_type: 'WASH_WORKER', login_role: null },
    ]
    const { management, staff } = partitionByManagement(rows)

    // Every row is accounted for exactly once. This is the property that makes
    // the two sections' counts trustworthy, and it is the one a "just filter it"
    // implementation breaks silently.
    expect(management.length + staff.length).toBe(rows.length)
    expect(new Set([...management, ...staff]).size).toBe(rows.length)
  })

  it('copes with an empty roster and with a role it does not recognise', () => {
    expect(partitionByManagement([])).toEqual({ management: [], staff: [] })

    // An unresolved login role must fall back to STAFF rather than vanish.
    const { management, staff } = partitionByManagement([
      { employee_type: 'CASHIER', login_role: null },
      { employee_type: 'CASHIER', login_role: 'SUPER_ADMIN' },
    ])
    expect(management).toHaveLength(0)
    expect(staff).toHaveLength(2)
  })
})

describe('attendanceAvailability', () => {
  it('offers a punch on an untouched day', () => {
    const available = attendanceAvailability(true, null, true)
    expect(available.checkIn).toBe(true)
    expect(available.checkOut).toBe(false)
    // Absence and leave are the same operation on the same untouched day, so they
    // are offered together with the punch rather than reserved for a manager.
    expect(available.absent).toBe(true)
    expect(available.leave).toBe(true)
  })

  it('offers only a check-out while the day is open', () => {
    const available = attendanceAvailability(true, NOT_PUNCHED, true)
    expect(available.checkIn).toBe(false)
    expect(available.checkOut).toBe(true)
  })

  it('offers nothing once the day is closed', () => {
    const available = attendanceAvailability(true, CLOSED, true)
    expect(available.checkIn).toBe(false)
    expect(available.checkOut).toBe(false)
    // A closed PRESENT day can never become an absence or a leave.
    expect(available.absent).toBe(false)
    expect(available.leave).toBe(false)
  })

  it('offers neither absence nor leave over an existing absence', () => {
    const available = attendanceAvailability(true, ABSENT, true)
    expect(available.absent).toBe(false)
    expect(available.leave).toBe(false)
    expect(available.checkIn).toBe(false)
  })

  it('offers neither absence nor leave over an existing leave', () => {
    const available = attendanceAvailability(true, LEAVE, true)
    expect(available.absent).toBe(false)
    expect(available.leave).toBe(false)
    expect(available.checkIn).toBe(false)
  })

  it('offers every action to a cashier operating attendance for a colleague', () => {
    // The roster a cashier sees is an attendance-operation table, so all four
    // actions are offered on an untouched day — the case the old manager-only
    // gate used to refuse.
    const available = attendanceAvailability(true, null, true)
    expect(available.canRecord).toBe(true)
    expect(available).toEqual({
      canRecord: true,
      checkIn: true,
      checkOut: false,
      absent: true,
      leave: true,
    })
  })

  it('offers an INACTIVE employee nothing at all', () => {
    expect(attendanceAvailability(false, null, true)).toEqual({
      canRecord: false,
      checkIn: false,
      checkOut: false,
      absent: false,
      leave: false,
    })
  })

  it('never offers a check-out with nothing to close', () => {
    // Mirrors the backend rule: a day that was never punched cannot be closed.
    const available = attendanceAvailability(true, null, true)
    expect(available.checkOut).toBe(false)
  })

  it('offers nothing at all to a caller who may not operate attendance', () => {
    // Not a security boundary — the service re-checks everything — but a screen
    // that offered a control guaranteed to be refused would be a bug.
    const available = attendanceAvailability(true, null, false)
    expect(available.canRecord).toBe(false)
    expect(available.checkIn).toBe(false)
    expect(available.absent).toBe(false)
    expect(available.leave).toBe(false)
  })
})

describe('todayOf', () => {
  it('projects a row that has no attendance today to nothing', () => {
    expect(
      todayOf({
        today_state: null,
        today_check_in_effective_at: null,
        today_check_out_effective_at: null,
      }),
    ).toBeNull()
  })

  it('projects the live row the backend sent', () => {
    expect(
      todayOf({
        today_state: 'PRESENT',
        today_check_in_effective_at: '2026-09-27 06:10:00Z',
        today_check_out_effective_at: null,
      }),
    ).toEqual({
      state: 'PRESENT',
      check_in_effective_at: '2026-09-27 06:10:00Z',
      check_out_effective_at: null,
    })
  })
})

describe('ATTENDANCE_ACTION', () => {
  it('maps every button to the wire value the backend expects', () => {
    // A typo here would silently send the wrong verb, so the map is exhaustive.
    expect(ATTENDANCE_ACTION).toEqual({
      checkIn: 'CHECK_IN',
      checkOut: 'CHECK_OUT',
      absent: 'ABSENT',
      leave: 'LEAVE',
    })
  })
})

describe('formatWorkDuration', () => {
  // A stand-in for i18next that echoes the key, so the assertion is about the
  // SHAPE the component asked for and not about the Arabic wording.
  const t = (key: string, options?: Record<string, unknown>) =>
    `${key}:${JSON.stringify(options ?? {})}`

  // The two modes the Dev Settings setting offers, and the exact values the
  // requirement names.
  it('renders a minute total in minutes mode', () => {
    expect(formatWorkDuration(485, 'minutes', t)).toContain('"minutes":485')
  })

  it('renders an APPROXIMATE decimal hour total in hours mode', () => {
    const rendered = formatWorkDuration(485, 'hours', t)
    expect(rendered).toContain('employees.duration.hoursOnly')
    // 485 / 60 = 8.083… → "8.1", and crucially NOT an "8h 5m" pair.
    expect(rendered).toContain('"hours":"8.1"')
    expect(rendered).not.toContain('minutes')
  })

  it('keeps a fixed one-decimal shape so a column of figures stays aligned', () => {
    for (const [minutes, hours] of [
      [0, '0.0'],
      [30, '0.5'],
      [390, '6.5'],
      [600, '10.0'],
      [485, '8.1'],
      [90, '1.5'],
    ] as const) {
      expect(formatWorkDuration(minutes, 'hours', t)).toContain(`"hours":"${hours}"`)
    }
  })

  it('rounds to the nearest tenth rather than truncating', () => {
    // 8 minutes is 0.133h: truncating would print a misleading "0.1" while a
    // value that rounds DOWN at the second decimal would print "0.1" too — this
    // asserts the half-up behaviour on a value that actually rounds up.
    expect(formatWorkDuration(95, 'hours', t)).toContain('"hours":"1.6"')
  })

  it('renders a sub-hour day as minutes when asked for minutes', () => {
    // The old formatter had a special "under an hour" branch. In minutes mode
    // every total is the same shape now, which is the point of the mode.
    expect(formatWorkDuration(45, 'minutes', t)).toContain('"minutes":45')
  })

  it('renders zero without producing NaN in either mode', () => {
    expect(formatWorkDuration(0, 'minutes', t)).toContain('"minutes":0')
    expect(formatWorkDuration(0, 'hours', t)).toContain('"hours":"0.0"')
  })

  it('never renders a negative or non-finite duration', () => {
    // A defensive floor, not a business rule: the backend clamps at zero, and a
    // UI that divided a negative by 60 would print "-0.2 س" and look like data.
    expect(formatWorkDuration(-90, 'hours', t)).toContain('"hours":"0.0"')
    expect(formatWorkDuration(Number.NaN, 'minutes', t)).toContain('"minutes":0')
  })
})

describe('the work-duration setting', () => {
  // The two things a setting must do: survive a restart, and leave everything
  // it does not own alone.
  afterEach(() => {
    resetFormattingPreferences()
    reloadFormattingPreferences()
  })

  it('defaults to hours, because that is what the app displayed before', () => {
    expect(DEFAULT_FORMATTING.workDuration.display).toBe('hours')
    expect(sanitizePreferences({}).workDuration.display).toBe('hours')
  })

  it('falls back to the default for a missing or unrecognised stored value', () => {
    // An installation saved before this setting existed has no key at all.
    expect(sanitizePreferences({ money: {} }).workDuration.display).toBe('hours')
    // A corrupt one must not become an unreachable screen state either.
    expect(
      sanitizePreferences({ workDuration: { display: 'fortnights' } }).workDuration.display,
    ).toBe('hours')
  })

  it('persists across a reload, the way a restart would', () => {
    setWorkDurationSettings({ display: 'minutes' })
    expect(reloadFormattingPreferences().workDuration.display).toBe('minutes')

    setWorkDurationSettings({ display: 'hours' })
    expect(reloadFormattingPreferences().workDuration.display).toBe('hours')
  })

  it('never rolls the mode back when an unrelated setting is saved', () => {
    setWorkDurationSettings({ display: 'minutes' })

    // Exactly what the Dev Settings money/date "Save Changes" writes.
    const current = reloadFormattingPreferences()
    replaceFormattingPreferences({
      ...current,
      money: { ...current.money, decimalPlaces: 0 },
    })

    expect(reloadFormattingPreferences().workDuration.display).toBe('minutes')
    expect(reloadFormattingPreferences().money.decimalPlaces).toBe(0)
  })

  it('changes the rendering, never the stored minutes', () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      `${key}:${JSON.stringify(options ?? {})}`

    // The canonical value is 485 either way; only the presentation moves.
    expect(formatWorkDuration(485, 'minutes', t)).toContain('"minutes":485')
    expect(formatWorkDuration(485, 'hours', t)).toContain('"hours":"8.1"')
    // …and switching back is exact, not lossy: the total is recoverable.
    expect(formatWorkDuration(485, 'minutes', t)).toContain('"minutes":485')
  })
})

describe('the state machine is pure', () => {
  it('does not mutate the facts it reads', () => {
    const facts = { ...NOT_PUNCHED }
    attendanceAvailability(true, facts, true)
    expect(facts).toEqual(NOT_PUNCHED)
  })

  it('does not read the clock or reach the network', () => {
    // A state machine that consulted the network or the wall clock would make
    // the UI's answer drift from the service's, and would break the offline
    // guarantee. The spies prove it does neither.
    const dateSpy = vi.spyOn(Date, 'now')
    attendanceAvailability(true, CLOSED, true)
    expect(dateSpy).not.toHaveBeenCalled()
    dateSpy.mockRestore()
  })
})

/**
 * The override draft — what a manager is shown and what the backend is told.
 *
 * These are the FORM-side assertions only. The service re-checks every one of
 * them (and the rounding rule the form deliberately does NOT apply) in Rust.
 */
describe('toTimeInputValue', () => {
  it('reads a stored instant in the Station business wall clock, not the browser one', () => {
    // 06:10Z is 09:10 in Africa/Cairo. A form that used the machine's own
    // timezone would offer a time the manager never recorded.
    expect(toTimeInputValue('2026-09-27 06:10:00Z')).toBe('09:10')
    expect(toTimeInputValue('2026-09-27 15:20:00Z')).toBe('18:20')
  })

  it('is an empty field for an absent punch, never a zero', () => {
    // "00:00" would be a real — and wrong — statement about an open day.
    expect(toTimeInputValue(null)).toBe('')
    expect(toTimeInputValue(undefined)).toBe('')
    expect(toTimeInputValue('not a timestamp')).toBe('')
  })

  it('zero-pads, so the string order of two values is the time order', () => {
    expect(toTimeInputValue('2026-09-27 05:03:00Z')).toBe('08:03')
  })
})

describe('overrideDraftOf', () => {
  it('opens on the day exactly as it stands', () => {
    expect(
      overrideDraftOf({
        check_in_effective_at: '2026-09-27 05:10:00Z',
        check_out_effective_at: '2026-09-27 13:10:00Z',
      }),
    ).toEqual({ checkIn: '08:10', checkOut: '16:10' })
  })

  it('leaves the check-out empty on an open day', () => {
    expect(
      overrideDraftOf({
        check_in_effective_at: '2026-09-27 05:10:00Z',
        check_out_effective_at: null,
      }),
    ).toEqual({ checkIn: '08:10', checkOut: '' })
  })
})

describe('overrideDraftError', () => {
  const original: OverrideDraft = { checkIn: '08:10', checkOut: '16:10' }

  it('accepts a move in either direction', () => {
    for (const draft of [
      { checkIn: '08:00', checkOut: '16:10' },
      { checkIn: '08:30', checkOut: '16:10' },
      { checkIn: '08:10', checkOut: '16:00' },
      { checkIn: '08:10', checkOut: '16:30' },
      // Off the ten-minute grid on purpose: the form must not round.
      { checkIn: '08:07', checkOut: '16:33' },
    ]) {
      expect(overrideDraftError(draft, original), JSON.stringify(draft)).toBeNull()
    }
  })

  it('refuses an untouched pair', () => {
    expect(overrideDraftError({ ...original }, original)).toBe('unchanged')
  })

  it('refuses a check-out that is not after the check-in', () => {
    expect(overrideDraftError({ checkIn: '08:10', checkOut: '08:00' }, original)).toBe(
      'invalidPair',
    )
    // Equal is the same violation the service refuses, so the form does too.
    expect(overrideDraftError({ checkIn: '08:10', checkOut: '08:10' }, original)).toBe(
      'invalidPair',
    )
  })

  it('refuses a cleared check-in, because a present day must keep one', () => {
    expect(overrideDraftError({ checkIn: '', checkOut: '16:10' }, original)).toBe('required')
  })

  it('allows an open day to stay open', () => {
    const open: OverrideDraft = { checkIn: '08:10', checkOut: '' }
    expect(overrideDraftError({ checkIn: '08:15', checkOut: '' }, open)).toBeNull()
  })
})

describe('overrideTimesOf', () => {
  const original: OverrideDraft = { checkIn: '08:10', checkOut: '16:10' }

  it('sends the stated wall clocks', () => {
    expect(overrideTimesOf({ checkIn: '08:00', checkOut: '16:30' }, original)).toEqual({
      check_in: '08:00',
      check_out: '16:30',
    })
  })

  it('sends null for a side the manager did not move', () => {
    // The correction can only rewrite what it names, so an untouched check-out
    // is never re-stated — not even with the value already on screen.
    expect(overrideTimesOf({ checkIn: '08:15', checkOut: '16:10' }, original)).toEqual({
      check_in: '08:15',
      check_out: null,
    })
    expect(overrideTimesOf({ checkIn: '08:10', checkOut: '16:45' }, original)).toEqual({
      check_in: null,
      check_out: '16:45',
    })
  })

  it('never turns a blank field into a zero time', () => {
    expect(overrideTimesOf({ checkIn: '08:15', checkOut: '' }, original)).toEqual({
      check_in: '08:15',
      check_out: null,
    })
  })
})
