/** App shell: topbar (logo, user, logout) + role-filtered sidebar + views. */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/LogoPlaceholder'
import { Badge, Button } from '@/components/ui'
import { useRouter, type View } from './router'
import { atLeast, useSession } from '@/features/auth/useSession'

interface NavItem {
  view: View
  minRole: 'STAFF' | 'MANAGER'
  labelKey: string
}

const NAV: NavItem[] = [
  { view: 'pos', minRole: 'STAFF', labelKey: 'nav.pos' },
  { view: 'staff', minRole: 'MANAGER', labelKey: 'nav.staff' },
  // Future workstreams are registered here as their pages land (2.2+).
]

export default function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { user, logout } = useSession()
  const { view, navigate } = useRouter()
  const items = NAV.filter((n) => atLeast(user?.role, n.minRole))

  return (
    <div dir="rtl" className="flex min-h-screen bg-surface">
      <aside className="flex w-56 shrink-0 flex-col border-l border-brand-200 bg-surface-raised p-4">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Logo size={56} />
          <p className="text-sm font-bold text-brand-900">{t('app.name')}</p>
        </div>
        <nav className="flex flex-col gap-1">
          {items.map((n) => (
            <button
              key={n.view}
              type="button"
              onClick={() => navigate(n.view)}
              className={`rounded-md px-3 py-2 text-right text-sm font-medium transition-colors ${
                view === n.view ? 'bg-brand-700 text-white' : 'text-brand-800 hover:bg-brand-100'
              }`}
            >
              {t(n.labelKey)}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-brand-200 bg-surface-raised px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-brand-800">{user?.name}</span>
            <Badge
              tone={
                user?.role === 'ADMIN' ? 'danger' : user?.role === 'MANAGER' ? 'info' : 'neutral'
              }
            >
              {user ? t(`roles.${user.role}`) : ''}
            </Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            {t('auth.logout')}
          </Button>
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  )
}
