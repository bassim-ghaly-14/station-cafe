/**
 * Mobile navigation: a fixed bottom bar plus a "More" sheet.
 *
 * Why this exists at all
 * ----------------------
 * The desktop sidebar is a hover-and-pin flyout: it opens on `onMouseEnter`,
 * closes on `onMouseLeave`, and its open/closed state is stored in
 * `localStorage`. None of that is reachable on a phone. There is no hover and
 * no pointer to leave, and a "pinned" sidebar that occupies 0 or 14rem of a
 * 360px viewport is either invisible or a full-screen takeover. Squeezing that
 * sidebar into a phone would have produced a navigation nobody can operate, so
 * the phone gets a purpose-built one and the desktop keeps its own.
 *
 * Why the bar has four slots and not nine
 * ---------------------------------------
 * A bottom bar with nine destinations is unusable: the labels are unreadable
 * and the tap targets fall below any reasonable size. So the bar carries the
 * `primary` destinations from `@/app/navigation` - the ones a Station user
 * reaches many times a shift AND that every role may open - and everything
 * else lives behind "More". Both surfaces read the SAME list, so a destination
 * can never exist in one and be missing from the other.
 *
 * Direction, insets and the keyboard
 * ----------------------------------
 * The bar uses logical properties only, so it mirrors correctly in Arabic RTL
 * with no direction-specific rule. `env(safe-area-inset-bottom)` keeps it clear
 * of the iPhone home indicator and of Telegram's own bottom chrome, and
 * `viewport-fit=cover` in `index.html` is what makes those insets non-zero.
 *
 * Every item is a real `<button>` with an accessible name, so nothing depends
 * on hover, on a pointer, or on the icon alone. This renders identically in a
 * phone browser and inside a Telegram WebApp, because it is ordinary DOM.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouter } from '@/app/router'
import { isNavViewActive, primaryNav, visibleNav } from '@/app/navigation'
import { cn } from '@/lib/utils'
import { useSession } from '@/features/auth/useSession'
import { Sheet } from '@/components/ui/sheet'
import { Menu, type LucideIcon } from '@/components/ui/icon'

export function MobileNav() {
  const { t } = useTranslation()
  const { view, navigate } = useRouter()
  const { user } = useSession()
  const [moreOpen, setMoreOpen] = useState(false)

  // Both lists are derived from the single navigation config through the same
  // role gate the desktop sidebar uses, so a MANAGER-only destination can never
  // be reached here by a STAFF session.
  const primary = primaryNav(user?.role)
  const all = visibleNav(user?.role)

  /*
   * A route change made from anywhere (a page button, the "More" sheet, a
   * browser back) must leave the sheet closed. Otherwise choosing a
   * destination from "More" would navigate underneath a menu still covering the
   * screen - the most common way a mobile drawer gets stuck open.
   */
  useEffect(() => {
    setMoreOpen(false)
  }, [view])

  return (
    <>
      <nav
        aria-label={t('nav.menu')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="flex items-stretch justify-around">
          {primary.map((item) => {
            const Icon = item.icon
            const active = isNavViewActive(view, item.view)

            return (
              <li key={item.view} className="min-w-0 flex-1">
                <NavButton
                  icon={Icon}
                  label={t(item.labelKey)}
                  active={active}
                  onClick={() => navigate(item.view)}
                />
              </li>
            )
          })}

          {/*
            "More" is the secondary navigation. It is highlighted whenever the
            current route is NOT one of the bar's own destinations, so the
            indicator never lies about where the user actually is.
          */}
          <li className="min-w-0 flex-1">
            <NavButton
              icon={Menu}
              label={t('nav.more')}
              active={moreOpen || !primary.some((item) => isNavViewActive(view, item.view))}
              expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            />
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={t('nav.allSections')}>
        {/*
          The COMPLETE list for this role, in the same declared order as the
          desktop sidebar - including the privileged destinations this session
          is actually allowed to open, and the POS sub-pages that are not
          separate bar slots.
        */}
        <ul className="flex flex-col gap-1">
          {all.map((item) => {
            const Icon = item.icon
            const active = isNavViewActive(view, item.view)

            return (
              <li key={item.view}>
                <button
                  type="button"
                  onClick={() => navigate(item.view)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2.5 text-start text-base font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground active:bg-surface-active',
                  )}
                >
                  <Icon size={20} aria-hidden />
                  {t(item.labelKey)}
                </button>
              </li>
            )
          })}
        </ul>
      </Sheet>
    </>
  )
}

/**
 * One bottom-bar slot.
 *
 * The label is always rendered, never icon-only: it is what makes the control
 * understandable at a glance, what gives it its accessible name, and what
 * distinguishes three text glyphs that are otherwise easy to confuse. The
 * target is comfortably above the 44px minimum because this is the primary
 * navigation on a phone held in one hand.
 */
function NavButton({
  icon: Icon,
  label,
  active,
  expanded,
  onClick,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly active: boolean
  /** For a control that opens a panel rather than navigating. */
  readonly expanded?: boolean
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-expanded={expanded}
      className={cn(
        'flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 py-1.5 transition-colors',
        active ? 'text-primary' : 'text-foreground-muted active:bg-surface-active',
      )}
    >
      <Icon size={22} aria-hidden />
      <span className="max-w-full truncate text-xs font-medium leading-tight">{label}</span>
    </button>
  )
}
