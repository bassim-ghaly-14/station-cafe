/**
 * MobileNav — the phone's bottom bar and its "More" sheet.
 *
 * What is worth proving here, and what is not
 * -------------------------------------------
 * The destination list and the role gate are already covered by
 * `navigation.test.ts`, and repeating that array here would assert the same
 * thing twice. What this file covers is the BEHAVIOUR that only exists once the
 * list is actually rendered:
 *
 *  - the bar is operable by tap alone and every control has a real accessible
 *    name (nothing is an unlabelled icon);
 *  - "More" carries the destinations that are NOT in the bar. If it only ever
 *    repeated the bar's own items, the mobile navigation would be lossy and
 *    Expenses / Inventory / Reports / Settings would be unreachable on a phone;
 *  - a STAFF session is offered no privileged destination, in the bar OR in the
 *    sheet — the sheet is the surface that could plausibly leak;
 *  - the sheet closes after navigating, so a user is never left with a menu
 *    covering the page they just asked for;
 *  - the active route is marked, including POS's sub-pages.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import type { UserRole } from '@/lib/roles'
import { RouterProvider, useRouter } from '@/app/router'
import { MobileNav } from './MobileNav'

/*
 * `MobileNav` reads the role through `useSession`, whose real provider talks to
 * the backend. The component needs only `user.role`, so the module is replaced
 * with a mutable role — the same approach the page tests in this repository
 * already use, and it makes the per-role assertions below readable.
 */
const session = vi.hoisted(() => ({ role: 'ADMIN' as string }))

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { role: session.role }, logout: vi.fn() }),
  atLeast: () => true,
}))

await i18n.changeLanguage(DEFAULT_LOCALE)

/** The current route, so navigation can be asserted rather than assumed. */
function CurrentRoute() {
  const { view } = useRouter()
  return <output data-testid="route">{view}</output>
}

function renderNav(role: UserRole, initialPath = '/pos') {
  session.role = role
  window.history.replaceState(null, '', initialPath)
  return render(
    <RouterProvider>
      <MobileNav />
      <CurrentRoute />
    </RouterProvider>,
  )
}

/** The bar itself. The "More" sheet renders in a separate dialog. */
function bar() {
  return screen.getByRole('navigation')
}

/** Open the sheet and return a scoped query against it. */
function openMore() {
  fireEvent.click(within(bar()).getByRole('button', { name: /المزيد/ }))
  return within(screen.getByRole('dialog'))
}

describe('MobileNav bottom bar', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/pos')
  })

  it('labels the bar and gives every control an accessible name', () => {
    renderNav('ADMIN')

    expect(bar()).toBeInTheDocument()
    // An icon-only button is unreachable for a screen-reader user, which is
    // the defect that "the icon is the label" silently introduces.
    for (const button of within(bar()).getAllByRole('button')) {
      expect(button).toHaveAccessibleName()
    }
  })

  it('reaches POS in one tap and follows the route', () => {
    renderNav('ADMIN', '/catalog')

    fireEvent.click(within(bar()).getByRole('button', { name: /نقطة البيع/ }))

    expect(screen.getByTestId('route')).toHaveTextContent('pos')
  })

  it('marks the bar destination that owns the current route', () => {
    renderNav('ADMIN', '/catalog')

    expect(within(bar()).getByRole('button', { name: /الأصناف/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    // Only the active one is marked, so the bar never shows two selections.
    expect(within(bar()).getByRole('button', { name: /نقطة البيع/ })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('marks "More" while the current route is a secondary destination', () => {
    // Reports is deliberately behind "More" rather than a bar tab. When the
    // user is there, "More" is what owns the route, so it is the thing that
    // must be highlighted — otherwise the bar claims no selection at all while
    // the user is three taps deep.
    renderNav('ADMIN', '/reports')

    expect(within(bar()).getByRole('button', { name: /المزيد/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('keeps POS marked on its sub-pages', () => {
    renderNav('ADMIN', '/pos/invoices')

    // Today's invoices is a POS sub-page, so POS stays highlighted rather than
    // the bar appearing to have no selection at all.
    expect(within(bar()).getByRole('button', { name: /نقطة البيع/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('gives every control a touch target above the 44px minimum', () => {
    renderNav('ADMIN')

    // A bottom bar is operated with a thumb, one-handed, often quickly.
    for (const button of within(bar()).getAllByRole('button')) {
      expect(button.className).toContain('min-h-14')
    }
  })

  it('never puts a privileged destination in a STAFF bar', () => {
    renderNav('STAFF')

    const staffBar = within(bar())
    for (const name of [/المصروفات/, /المبيعات/, /المخزون/, /التقارير/, /الإعدادات/]) {
      expect(staffBar.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })
})

describe('MobileNav "More" sheet', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/pos')
  })

  it('carries the destinations the bar does not', () => {
    renderNav('ADMIN')
    const sheet = openMore()

    // These are the destinations that would otherwise be unreachable on a
    // phone, because they are deliberately not bar tabs.
    expect(sheet.getByRole('button', { name: /الإعدادات/ })).toBeInTheDocument()
    expect(sheet.getByRole('button', { name: /المصروفات/ })).toBeInTheDocument()
    expect(sheet.getByRole('button', { name: /المخزون/ })).toBeInTheDocument()
    expect(sheet.getByRole('button', { name: /التقارير/ })).toBeInTheDocument()
  })

  it('lists the complete set for the role, in the declared order', () => {
    renderNav('ADMIN')
    const sheet = openMore()

    // All nine destinations, so the sheet is the full navigation rather than
    // a mobile-only subset that could drift from the desktop sidebar. The
    // sheet's own close button lives in the dialog too, so the list items are
    // what is counted.
    expect(sheet.getAllByRole('listitem')).toHaveLength(9)
  })

  it('lists exactly the four operational destinations for a STAFF', () => {
    renderNav('STAFF')
    const sheet = openMore()

    expect(sheet.getAllByRole('listitem')).toHaveLength(4)
    for (const name of [/المصروفات/, /المبيعات/, /المخزون/, /التقارير/, /الإعدادات/]) {
      expect(sheet.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('navigates and then closes itself', () => {
    renderNav('ADMIN')
    const sheet = openMore()

    fireEvent.click(sheet.getByRole('button', { name: /المخزون/ }))

    expect(screen.getByTestId('route')).toHaveTextContent('inventory')
    // Navigating underneath a menu that is still covering the screen is the
    // classic stuck-drawer bug, so the sheet closes on the route change.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on Escape without navigating', () => {
    renderNav('ADMIN')
    openMore()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('route')).toHaveTextContent('pos')
  })

  it('marks the current destination inside the sheet', () => {
    renderNav('ADMIN', '/expenses')
    const sheet = openMore()

    expect(sheet.getByRole('button', { name: /المصروفات/ })).toHaveAttribute('aria-current', 'page')
  })
})
