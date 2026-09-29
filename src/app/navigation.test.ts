/**
 * The navigation configuration, and the role gate that decides who may see what.
 *
 * The risk this file exists to control
 * ------------------------------------
 * Station's navigation is now rendered from ONE list in two places: the desktop
 * sidebar and the phone's bottom bar plus "More" sheet. That is the right design
 * — it is what makes the two impossible to drift — but it means a mistake in
 * `minRole` is now a mistake in BOTH surfaces at once, and on a shared till
 * phone a privileged destination is one tap away from a cashier who has no
 * business opening it.
 *
 * So the gate is asserted directly, per role, against the exact destinations
 * that carry financial, settings, development or employee-management authority.
 * The backend remains the real boundary; this is the UI convenience, and it is
 * the one a user can SEE, so it has to be right on its own terms.
 */
import { describe, expect, it } from 'vitest'
import { NAV, isNavViewActive, primaryNav, visibleNav } from './navigation'
import i18n from '@/lib/i18n'
import { roleRank, type UserRole } from '@/lib/roles'

const views = (role: UserRole | undefined) => visibleNav(role).map((n) => n.view)

describe('navigation configuration', () => {
  it('keeps the declared order the desktop sidebar has always shown', () => {
    // The order below is the documented navigation order; changing it changes
    // the desktop sidebar, so it is pinned here rather than left to drift.
    expect(NAV.map((n) => n.view)).toEqual([
      'pos',
      'catalog',
      'customers',
      'employees',
      'expenses',
      'sales',
      'inventory',
      'reports',
      'dev-settings',
    ])
  })

  it('gives every destination a label key and an icon', () => {
    for (const item of NAV) {
      expect(item.labelKey, item.view).toMatch(/^nav\./)
      expect(item.icon, item.view).toBeDefined()
      // The optional short form is a navigation key like any other, and a
      // destination must never name a DIFFERENT place than its full label does.
      if (item.mobileLabelKey) expect(item.mobileLabelKey, item.view).toMatch(/^nav\./)
    }
  })

  it('shortens a bar label only where the full name cannot fit a slot', () => {
    /*
     * A bar slot is a quarter of a 320–430px viewport at `text-xs`. Anything
     * past roughly a dozen Arabic characters is cut mid-word there, so the
     * destinations long enough to need a short form must DECLARE one — and the
     * short forms must be genuinely short, not the same long word again.
     */
    const short = i18n.t.bind(i18n)
    for (const item of primaryNav('ADMIN')) {
      const label = short(item.labelKey)
      if (label.length <= 12) {
        expect(item.mobileLabelKey, item.view).toBeUndefined()
        continue
      }
      expect(item.mobileLabelKey, `${item.view} needs a bar label`).toBeDefined()
      const mobile = short(item.mobileLabelKey as string)
      expect(mobile.length, `${item.view} bar label`).toBeLessThan(label.length)
      // And it is a prefix of the full name, so the bar's visible text is
      // contained in the accessible name (WCAG "label in name") and the tab
      // still names the same place.
      expect(label.startsWith(mobile), `${item.view} bar label`).toBe(true)
    }
  })

  it('declares no duplicate destinations', () => {
    // A duplicate would render two entries for one route, one of which could
    // never be highlighted.
    expect(new Set(NAV.map((n) => n.view)).size).toBe(NAV.length)
  })
})

describe('role-based navigation', () => {
  it('shows a STAFF the operational workspaces and nothing more', () => {
    expect(views('STAFF')).toEqual(['pos', 'catalog', 'customers', 'employees'])
  })

  it('gives a MANAGER the financial workspaces but not settings', () => {
    expect(views('MANAGER')).toEqual([
      'pos',
      'catalog',
      'customers',
      'employees',
      'expenses',
      'sales',
      'inventory',
      'reports',
    ])
  })

  it('gives an ADMIN every destination', () => {
    expect(views('ADMIN')).toEqual(NAV.map((n) => n.view))
  })

  it('shows an unresolved session nothing at all', () => {
    // An absent or unrecognised role ranks 0, below even STAFF's floor, so a
    // session that has not resolved yet can never flash the full navigation.
    expect(views(undefined)).toEqual([])
  })

  it('never exposes expenses, sales, inventory, reports or settings to a STAFF', () => {
    // Spelled out individually because these are the destinations whose
    // exposure would actually matter: money, reporting, and the settings and
    // development areas.
    const staff = views('STAFF')
    for (const restricted of [
      'expenses',
      'sales',
      'inventory',
      'reports',
      'dev-settings',
    ] as const) {
      expect(staff, `STAFF must not see ${restricted}`).not.toContain(restricted)
    }
  })

  it('keeps development settings to an ADMIN alone', () => {
    expect(views('ADMIN')).toContain('dev-settings')
    expect(views('MANAGER')).not.toContain('dev-settings')
    expect(views('STAFF')).not.toContain('dev-settings')
  })

  it('never widens a destination above the role the desktop sidebar used', () => {
    // A direct comparison against the original per-destination floors. If this
    // fails, the mobile pass has granted something the desktop never did.
    const original: Record<string, UserRole> = {
      pos: 'STAFF',
      catalog: 'STAFF',
      customers: 'STAFF',
      employees: 'STAFF',
      expenses: 'MANAGER',
      sales: 'MANAGER',
      inventory: 'MANAGER',
      reports: 'MANAGER',
      'dev-settings': 'ADMIN',
    }
    for (const item of NAV) {
      expect(item.minRole, item.view).toBe(original[item.view])
    }
  })
})

describe('the mobile bottom bar', () => {
  it('offers only a compact set of primary destinations', () => {
    // The whole point of the "More" mechanism. Nine tabs is not a navigation,
    // it is a word wrapped in a row.
    expect(primaryNav('ADMIN').length).toBeLessThanOrEqual(4)
  })

  it('only ever puts STAFF-reachable destinations in the bar', () => {
    /*
     * The rule that makes a shared till phone safe: a destination is `primary`
     * only if EVERY role can open it. A MANAGER-only or ADMIN-only tab would
     * sit on the bar of a device a cashier also uses, offering a destination
     * the backend would refuse.
     */
    const staffViews = new Set(views('STAFF'))
    for (const item of primaryNav('ADMIN')) {
      expect(staffViews, `${item.view} must be reachable by a STAFF`).toContain(item.view)
    }
  })

  it('keeps the POS workspace reachable in one tap for every role', () => {
    // POS is the screen the application exists for; it is never behind "More".
    for (const role of ['STAFF', 'MANAGER', 'ADMIN'] as const) {
      expect(
        primaryNav(role).map((n) => n.view),
        role,
      ).toContain('pos')
    }
  })

  it('never puts every destination in the bar', () => {
    // Guards the "More" mechanism against being quietly deleted: if the bar
    // grew to hold everything, the sheet would have nothing left to offer.
    expect(primaryNav('ADMIN').length).toBeLessThan(visibleNav('ADMIN').length)
  })
})

describe('active-route highlighting', () => {
  it('marks the exact destination active', () => {
    expect(isNavViewActive('reports', 'reports')).toBe(true)
    expect(isNavViewActive('reports', 'pos')).toBe(false)
  })

  it('keeps POS highlighted on its sub-pages', () => {
    // Today's invoices and wash tickets are POS sub-pages reached from the POS
    // screen. Without this the bar would show nothing selected while the user
    // is two taps deep in a sub-page.
    expect(isNavViewActive('today-invoices', 'pos')).toBe(true)
    expect(isNavViewActive('today-wash-tickets', 'pos')).toBe(true)
  })

  it('does not let a sub-page mark an unrelated destination active', () => {
    expect(isNavViewActive('today-invoices', 'catalog')).toBe(false)
    expect(isNavViewActive('today-invoices', 'customers')).toBe(false)
  })

  it('does not let one POS sub-page highlight another', () => {
    expect(isNavViewActive('today-wash-tickets', 'today-invoices')).toBe(false)
  })
})

describe('roleRank, as the navigation depends on it', () => {
  it('orders the roles ADMIN > MANAGER > STAFF', () => {
    expect(roleRank('ADMIN')).toBeGreaterThan(roleRank('MANAGER'))
    expect(roleRank('MANAGER')).toBeGreaterThan(roleRank('STAFF'))
  })

  it('ranks an unknown role below every real one', () => {
    expect(roleRank(undefined)).toBeLessThan(roleRank('STAFF'))
    expect(roleRank('NOT_A_ROLE')).toBeLessThan(roleRank('STAFF'))
  })
})
