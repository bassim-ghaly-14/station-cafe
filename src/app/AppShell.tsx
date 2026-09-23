/** App shell: topbar (logo, user, logout) + role-filtered sidebar + views. */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/LogoPlaceholder'
import { Badge } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  BarChart3,
  Boxes,
  LogOut,
  Package,
  Receipt,
  ScrollText,
  Store,
  Users,
  type LucideIcon,
} from '@/components/ui/icon'
import { useRouter, type View } from './router'
import { atLeast, useSession } from '@/features/auth/useSession'
import { Dialog } from '@/components/ui'

interface NavItem {
  view: View
  minRole: 'STAFF' | 'MANAGER'
  labelKey: string
  icon: LucideIcon
}

const NAV: NavItem[] = [
  { view: 'pos', minRole: 'STAFF', labelKey: 'nav.pos', icon: Store },
  { view: 'catalog', minRole: 'MANAGER', labelKey: 'nav.catalog', icon: Package },
  { view: 'expenses', minRole: 'MANAGER', labelKey: 'nav.expenses', icon: Receipt },
  { view: 'inventory', minRole: 'MANAGER', labelKey: 'nav.inventory', icon: Boxes },
  { view: 'reports', minRole: 'MANAGER', labelKey: 'nav.reports', icon: BarChart3 },
  { view: 'audit', minRole: 'MANAGER', labelKey: 'nav.audit', icon: ScrollText },
  { view: 'staff', minRole: 'MANAGER', labelKey: 'nav.staff', icon: Users },
]

export default function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { user, logout } = useSession()
  const { view, navigate } = useRouter()
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)

  const items = NAV.filter((n) => atLeast(user?.role, n.minRole))

  async function confirmLogout() {
    setLogoutConfirmOpen(false)
    await logout()
  }

  return (
    <div dir="rtl" className="flex min-h-screen bg-background">
      <aside className="flex w-56 shrink-0 flex-col border-l border-border bg-surface p-4">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo size={56} />
          <p className="text-sm font-bold text-foreground-strong">{t('app.name')}</p>
        </div>

        <nav className="flex flex-col gap-1">
          {items.map((n) => {
            const Icon = n.icon

            return (
              <button
                key={n.view}
                type="button"
                onClick={() => navigate(n.view)}
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
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-foreground-muted">{user?.name}</span>

            <Badge
              tone={
                user?.role === 'ADMIN' ? 'danger' : user?.role === 'MANAGER' ? 'info' : 'neutral'
              }
            >
              {user ? t(`roles.${user.role}`) : ''}
            </Badge>
          </div>

          <Button variant="destructiveGhost" size="sm" onClick={() => setLogoutConfirmOpen(true)}>
            <LogOut size={16} aria-hidden />
            {t('auth.logout')}
          </Button>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>

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
