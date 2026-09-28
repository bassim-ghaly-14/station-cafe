/** App shell: topbar + role-filtered collapsible sidebar + views.
 *
 * Two navigation surfaces, one configuration
 * ------------------------------------------
 * The desktop sidebar below and the phone's bottom bar (`MobileNav`) are two
 * renderings of the SAME `NAV` list in `@/app/navigation`, filtered by the same
 * `visibleNav()` role gate. Neither owns the destination list, so the two
 * cannot drift and a privileged destination cannot leak onto a phone.
 *
 * The split is decided by `useIsWide()` rather than by CSS alone, because a
 * sidebar merely hidden with `display: none` is still mounted: its buttons
 * stay in the accessibility tree, still parse in tests, and still cost
 * memory. Exactly one navigation surface exists at a time.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/Logo'
import { Badge, Button, DialogActions, EmployeeAvatar, ThemeToggle, Dialog } from '@/components/ui'
import { MobileNav } from '@/components/navigation/MobileNav'
import { ChevronRight, LogOut, Pin, PinOff } from '@/components/ui/icon'
import { isNavViewActive, visibleNav } from './navigation'
import { useRouter } from './router'
import { useSession } from '@/features/auth/useSession'
import { useIsWide } from '@/lib/use-media-query'

const SIDEBAR_STORAGE_KEY = 'station.sidebar.pinned'

function getInitialSidebarPinned(isStaff: boolean) {
  const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY)

  if (saved === 'true') return true
  if (saved === 'false') return false

  return !isStaff
}

export default function AppShell({ children }: Readonly<{ readonly children: ReactNode }>) {
  const { t } = useTranslation()
  const { user, logout } = useSession()
  const { view, navigate } = useRouter()

  /*
   * The one place the shell decides which navigation surface exists.
   *
   * `useIsWide()` matches the shared Tailwind `md` breakpoint (768px), which
   * is also the `md:hidden` guard on the bottom bar - so the two agree by
   * construction and there is no width at which both, or neither, is mounted.
   * A phone is a phone to this decision whether it is in a browser or inside a
   * Telegram WebApp: both report the same viewport.
   */
  const isWide = useIsWide()

  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)

  const isStaff = user?.role === 'STAFF'

  /*
   * STAFF defaults to collapsed.
   * MANAGER / ADMIN default to expanded.
   *
   * The user's last pinned state is restored from localStorage.
   */
  const [sidebarPinned, setSidebarPinned] = useState(() => getInitialSidebarPinned(isStaff))

  const [sidebarHovered, setSidebarHovered] = useState(false)

  const items = visibleNav(user?.role)

  /*
   * Pinned = permanently open.
   * Hovered = temporarily open.
   *
   * Both states make the sidebar part of the normal layout,
   * so opening it pushes the main content instead of overlaying it.
   */
  const sidebarOpen = sidebarPinned || sidebarHovered

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarPinned))
  }, [sidebarPinned])

  async function confirmLogout() {
    setLogoutConfirmOpen(false)
    await logout()
  }

  function closeSidebar() {
    setSidebarPinned(false)
    setSidebarHovered(false)
  }

  function togglePin() {
    setSidebarPinned((current) => !current)
  }

  return (
    <div dir="rtl" className="flex min-h-screen bg-background">
      {/*
       * Sidebar — DESKTOP ONLY.
       *
       * IMPORTANT:
       * On a wide screen this is NOT fixed and NOT overlayed: its width
       * participates in the main flex layout, so opening it pushes the content
       * rather than covering it. That behaviour is unchanged.
       *
       * On a phone it is not rendered at all. A hover-driven, `localStorage`
       * -pinned flyout has no way to be operated without a pointer, and its
       * 14rem open width would swallow a 360px viewport, so the phone gets
       * `MobileNav` instead. Rendering conditionally (rather than hiding this
       * with CSS) is deliberate: a `display: none` sidebar is still in the
       * accessibility tree, and a user navigating by screen reader or by
       * keyboard on a phone would still be offered a control that cannot open.
       */}
      {isWide ? (
        <aside
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => {
            if (!sidebarPinned) {
              setSidebarHovered(false)
            }
          }}
          className={`relative flex shrink-0 flex-col overflow-hidden border-l border-border bg-surface transition-[width] duration-200 ease-out ${
            sidebarOpen ? 'w-56' : 'w-0'
          }`}
        >
          <div className="flex h-full w-56 flex-col p-4">
            {/* Sidebar header */}
            <div className="relative mb-6 flex min-h-20 flex-col items-center justify-center gap-2">
              <Logo size={56} />

              <p className="text-sm font-bold text-foreground-strong">{t('app.name')}</p>

              {/* Pin / unpin */}
              <button
                type="button"
                onClick={togglePin}
                className="absolute left-0 top-0 flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:bg-surface-active"
                aria-label={sidebarPinned ? 'إلغاء تثبيت القائمة' : 'تثبيت القائمة'}
                title={sidebarPinned ? 'إلغاء تثبيت القائمة' : 'تثبيت القائمة'}
              >
                {sidebarPinned ? <Pin size={16} aria-hidden /> : <PinOff size={16} aria-hidden />}
              </button>

              {/* Close */}
              <button
                type="button"
                onClick={closeSidebar}
                className="absolute right-0 top-0 flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:bg-surface-active"
                aria-label="طي القائمة"
                title="طي القائمة"
              >
                <ChevronRight size={18} aria-hidden />
              </button>
            </div>

            {/* Navigation — the same `visibleNav()` list the phone renders. */}
            <nav aria-label={t('nav.menu')} className="flex flex-col gap-1">
              {items.map((n) => {
                const Icon = n.icon
                const active = isNavViewActive(view, n.view)

                return (
                  <button
                    key={n.view}
                    type="button"
                    onClick={() => {
                      navigate(n.view)

                      /*
                       * STAFF uses the sidebar as a temporary navigation.
                       * After choosing a page, close it unless pinned.
                       */
                      if (isStaff && !sidebarPinned) {
                        setSidebarHovered(false)
                      }
                    }}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 text-start text-base font-medium transition-colors ${
                      active
                        ? 'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active'
                        : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground active:bg-surface-active'
                    }`}
                  >
                    <Icon size={18} aria-hidden />
                    {t(n.labelKey)}
                  </button>
                )
              })}
            </nav>
          </div>
        </aside>
      ) : null}

      {/*
       * Collapsed sidebar trigger.
       *
       * It occupies only a tiny amount of layout space.
       * Hovering it opens the sidebar, which then pushes the content.
       *
       * Desktop only, for the same reason the sidebar itself is.
       */}
      {isWide && !sidebarPinned && !sidebarHovered ? (
        <div className="w-1 shrink-0" onMouseEnter={() => setSidebarHovered(true)} aria-hidden />
      ) : null}

      {/* Main application area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
         * The topbar.
         *
         * On a phone it carries the brand, because the sidebar that used to
         * show the logo is not there — a header with no identity at all is
         * what makes a web app feel like a web page rather than an installed
         * one, and on a shared till phone that matters.
         *
         * It is `sticky` on narrow screens so the signed-in identity and the
         * logout stay reachable without scrolling a long POS order back up.
         * The horizontal padding steps down (px-3 → px-6) because 24px of
         * padding on each side of a 360px screen costs 13% of the width.
         */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-3 sm:px-6">
          {/*
           * The brand block is phone-only. On desktop the sidebar already shows
           * the logo and the name directly above this bar, so repeating it
           * would be a second, competing identity in the same viewport.
           */}
          <div className="flex min-w-0 items-center gap-2 md:hidden">
            <Logo size={32} />
            <span className="truncate text-base font-bold text-foreground-strong">
              {t('app.name')}
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <EmployeeAvatar role={user?.role} size="sm" />
            <span className="truncate text-sm font-medium text-foreground-muted">{user?.name}</span>

            {/*
             * The role badge is the first thing to go on a narrow screen: the
             * name stays (it identifies whose shift this is), the badge does
             * not. It is decoration next to a name the user already knows, and
             * on a 360px phone the row has to hold the brand, the name and two
             * controls. It reappears from `sm` up, where there is room.
             */}
            <Badge role={user?.role} size="sm" dot className="hidden sm:inline-flex">
              {user ? t(`roles.${user.role}`) : ''}
            </Badge>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle />
            <Button variant="destructiveGhost" size="sm" onClick={() => setLogoutConfirmOpen(true)}>
              <LogOut size={16} aria-hidden />
              {/*
               * The visible label is dropped on a phone, where this row
               * competes with the brand for width. The accessible name is not
               * lost: `sr-only` keeps the same text in the accessibility tree,
               * so a screen reader still announces "تسجيل الخروج" rather than
               * an unlabelled icon button.
               */}
              <span className="hidden sm:inline">{t('auth.logout')}</span>
              <span className="sr-only sm:hidden">{t('auth.logout')}</span>
            </Button>
          </div>
        </header>

        {/*
          The page body.

          `p-6` becomes `p-3 sm:p-6`: on a 360px phone, 24px of padding on each
          side leaves 312px for the content, and a data table or a POS grid
          needs every one of those pixels.

          The extra bottom padding on a phone is what keeps the fixed bottom
          navigation from covering the last row of whatever page is open. It
          matches the bar's own height (a 56px target plus its safe-area
          inset) plus a little breathing room, and it is applied ONLY where the
          bar exists.
        */}
        <main
          className={
            isWide
              ? 'min-w-0 flex-1 p-6'
              : 'min-w-0 flex-1 p-3 pb-[calc(env(safe-area-inset-bottom)+5rem)]'
          }
        >
          {children}
        </main>
      </div>

      {/* Phone-only bottom navigation. Mounted only when the sidebar is not. */}
      {isWide ? null : <MobileNav />}

      {/* Logout confirmation */}
      <Dialog
        open={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        title={t('auth.logout')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-body">{t('auth.logoutConfirm')}</p>

          <DialogActions>
            <Button variant="outline" onClick={() => setLogoutConfirmOpen(false)}>
              {t('app.cancel')}
            </Button>

            <Button variant="destructiveGhost" onClick={() => void confirmLogout()}>
              <LogOut size={16} aria-hidden />
              {t('auth.logout')}
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </div>
  )
}
