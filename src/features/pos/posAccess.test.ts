/**
 * Who may open today's two daily records (فواتير اليوم / تذاكر المغسلة اليوم).
 *
 * The rule under test is the separation the POS page depends on: access is a
 * ROLE question, an open till is a SHIFT question, and record ownership is
 * neither. Each case below is a real situation the buttons used to get wrong.
 */
import { describe, expect, it } from 'vitest'
import { canOpenDailyRecords } from './posAccess'

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
