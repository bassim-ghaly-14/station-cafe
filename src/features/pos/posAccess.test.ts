/**
 * Who may open today's two daily records (فواتير اليوم / تذاكر المغسلة اليوم).
 *
 * The rule under test is the separation the POS page depends on: the ACTIVE
 * BUSINESS DAY decides whether there is a "today" at all, the ROLE decides who
 * may read it, and an open till is never part of the decision. Each case below
 * is a real situation the buttons used to get wrong.
 */
import { describe, expect, it } from 'vitest'
import { canOpenDailyRecords, canShowDailyRecords } from './posAccess'

describe('canOpenDailyRecords', () => {
  it('does not depend on the caller having an open shift', () => {
    // It takes no shift at all: that is the point. A manager reading the day is
    // not selling, and the backend serves both reads to any STAFF.
    expect(canOpenDailyRecords('MANAGER')).toBe(true)
    expect(canOpenDailyRecords('ADMIN')).toBe(true)
  })

  it('lets a cashier reach a colleague’s records', () => {
    // The backend filters neither read by `user_id`, so the UI must not imply
    // that an invoice or a ticket belongs to the person looking at it.
    expect(canOpenDailyRecords('STAFF')).toBe(true)
  })

  it('refuses an unresolved session rather than guessing', () => {
    // An absent or unrecognised role ranks below STAFF, so a screen rendered
    // before the session resolves offers nothing rather than everything.
    expect(canOpenDailyRecords(undefined)).toBe(false)
  })
})

describe('canShowDailyRecords', () => {
  const day = { id: 1, day_date: '2026-09-25', status: 'OPEN', opened_at: '2026-09-25 08:00:00Z' }

  it('shows the records while the business day is active and the role permits', () => {
    // STATE 2/3: day open, personal shift missing or closed — history belongs to
    // the active day, so it stays visible as secondary context.
    expect(canShowDailyRecords('STAFF', day)).toBe(true)
    expect(canShowDailyRecords('MANAGER', day)).toBe(true)
    expect(canShowDailyRecords('ADMIN', day)).toBe(true)
  })

  it('hides the records when no business day is active, regardless of role', () => {
    // STATE 1/5: cold till or closed/finalized day — `day` is `null`, so there
    // is no "today" for the buttons to mean. Historical existence ≠ active day.
    expect(canShowDailyRecords('STAFF', null)).toBe(false)
    expect(canShowDailyRecords('MANAGER', null)).toBe(false)
    expect(canShowDailyRecords('ADMIN', null)).toBe(false)
  })

  it('keeps the role floor on top of the day lifecycle', () => {
    // An unresolved session offers nothing even on an open day.
    expect(canShowDailyRecords(undefined, day)).toBe(false)
    expect(canShowDailyRecords(undefined, null)).toBe(false)
  })
})
