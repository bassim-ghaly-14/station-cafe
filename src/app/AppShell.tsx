/** App shell: topbar + role-filtered collapsible sidebar + views. */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/Logo'
import { Badge, Button, EmployeeAvatar, ThemeToggle } from '@/components/ui'
import {
  BarChart3,
  Boxes,
  ChevronRight,
  HandCoins,
  LogOut,
  Package,
  Pin,
  PinOff,
  Receipt,
  Store,
  Settings,
  UserRound,
  Users,
  type LucideIcon,
} from '@/components/ui/icon'
import { useRouter, type View } from './router'
import { atLeast, useSession } from '@/features/auth/useSession'
import { Dialog } from '@/components/ui'

interface NavItem {
  view: View
  minRole: 'STAFF' | 'MANAGER' | 'ADMIN'
  labelKey: string
  icon: LucideIcon
}

const NAV: NavItem[] = [
  { view: 'pos', minRole: 'STAFF', labelKey: 'nav.pos', icon: Store },
  { view: 'catalog', minRole: 'STAFF', labelKey: 'nav.catalog', icon: Package },
  // The customer workspace is operational: every role may list, search and
  // register customers. Its financial layer is gated by the backend, not here.
  { view: 'customers', minRole: 'STAFF', labelKey: 'nav.customers', icon: UserRound },
  { view: 'expenses', minRole: 'MANAGER', labelKey: 'nav.expenses', icon: Receipt },
  { view: 'inventory', minRole: 'MANAGER', labelKey: 'nav.inventory', icon: Boxes },
  // The sales workspace is the manager's operational view of the business. It
  // replaced the two sales tabs that used to live inside Reports, so Reports
  // now holds only reporting (audit, printing, closings, charts).
  { view: 'sales', minRole: 'MANAGER', labelKey: 'nav.sales', icon: HandCoins },
  { view: 'reports', minRole: 'MANAGER', labelKey: 'nav.reports', icon: BarChart3 },
  { view: 'staff', minRole: 'MANAGER', labelKey: 'nav.staff', icon: Users },
  { view: 'dev-settings', minRole: 'ADMIN', labelKey: 'nav.devSettings', icon: Settings },
]

const SIDEBAR_STORAGE_KEY = 'station.sidebar.pinned'

function getInitialSidebarPinned(isStaff: boolean) {
  const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY)

  if (saved === 'true') return true
  if (saved === 'false') return false

  return !isStaff
}

export default function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { user, logout } = useSession()
  const { view, navigate } = useRouter()

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

  const items = NAV.filter((n) => atLeast(user?.role, n.minRole))

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
       * Sidebar
       *
       * IMPORTANT:
       * This is NOT fixed and NOT overlayed.
       * Its width participates in the main flex layout.
       */}
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

          {/* Navigation */}
          <nav className="flex flex-col gap-1">
            {items.map((n) => {
              const Icon = n.icon

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
                  aria-current={view === n.view ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2.5 text-start text-base font-medium transition-colors ${
                    view === n.view
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

      {/*
       * Collapsed sidebar trigger.
       *
       * It occupies only a tiny amount of layout space.
       * Hovering it opens the sidebar, which then pushes the content.
       */}
      {!sidebarPinned && !sidebarHovered && (
        <div className="w-1 shrink-0" onMouseEnter={() => setSidebarHovered(true)} aria-hidden />
      )}

      {/* Main application area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <EmployeeAvatar role={user?.role} size="sm" />
            <span className="truncate text-sm font-medium text-foreground-muted">{user?.name}</span>

            <Badge role={user?.role} size="sm" dot>
              {user ? t(`roles.${user.role}`) : ''}
            </Badge>
          </div>

          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button variant="destructiveGhost" size="sm" onClick={() => setLogoutConfirmOpen(true)}>
              <LogOut size={16} aria-hidden />
              {t('auth.logout')}
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>

      {/* Logout confirmation */}
      <Dialog
        open={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        title={t('auth.logout')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-body">{t('auth.logoutConfirm')}</p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setLogoutConfirmOpen(false)}>
              {t('app.cancel')}
            </Button>

            <Button variant="destructiveGhost" onClick={() => void confirmLogout()}>
              <LogOut size={16} aria-hidden />
              {t('auth.logout')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
