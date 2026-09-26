/** Staff management (MANAGER+). Create staff, set status, assign roles,
 * and configure each cashier's discount-authorization credential. */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, Card, CardHeader, EmployeeAvatar, TableSkeleton } from '@/components/ui'
import { Button } from '@/components/ui/button'
import { Lock, Plus, Power } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { staffBadgeVariant } from '@/lib/status-badge'
import { call } from '@/services/ipc'
import { staffApi, type StaffDiscountAuthorization } from '@/services/posApi'
import { useSession, type User } from '../auth/useSession'
import { AddStaffDialog } from './AddStaffDialog'
import { DiscountAuthorizationDialog } from './DiscountAuthorizationDialog'

export default function StaffPage() {
  const { t } = useTranslation()
  const { user } = useSession()
  const toast = useToast()
  const [staff, setStaff] = useState<User[] | null>(null)
  const [discountAuth, setDiscountAuth] = useState<Record<number, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [discountTarget, setDiscountTarget] = useState<User | null>(null)

  const refresh = useCallback(() => {
    setStaff(null)
    setError(null)
    Promise.all([
      call<User[]>('list_staff'),
      // Flags only — the credential itself never reaches the frontend.
      staffApi.discountAuthorization().catch(() => [] as StaffDiscountAuthorization[]),
    ])
      .then(([people, authorization]) => {
        setStaff(people)
        setDiscountAuth(
          Object.fromEntries(authorization.map((entry) => [entry.user_id, entry.configured])),
        )
      })
      .catch((e) => setError(t([`errors.${e.message}`, 'errors.internal_error'])))
  }, [t])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function toggleStatus(u: User) {
    const next = u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'
    try {
      await call<void>('set_staff_status', { user_id: u.id, status: next })
      toast(t('staff.saved'), 'success')
      refresh()
    } catch (e) {
      toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t('nav.staff')}
          subtitle={t('staff.subtitle')}
          actions={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus size={16} aria-hidden />
              {t('staff.addStaff')}
            </Button>
          }
        />
        {error ? (
          <ErrorState message={error} onRetry={refresh} retryLabel={t('app.retry')} />
        ) : !staff ? (
          <TableSkeleton rows={6} columns={5} />
        ) : staff.length === 0 ? (
          <EmptyState title={t('staff.empty')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-foreground-subtle">
                <th className="p-2 font-medium">{t('staff.name')}</th>
                <th className="p-2 font-medium">{t('staff.phone')}</th>
                <th className="p-2 font-medium">{t('roles.title')}</th>
                <th className="p-2 font-medium">{t('staff.discountAuthorization')}</th>
                <th className="p-2 font-medium">{t('app.status')}</th>
                <th className="p-2 font-medium">{t('app.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <tr key={u.id} className="border-b border-border-subtle">
                  <td className="p-2">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground-strong">
                      <EmployeeAvatar role={u.role} size="sm" />
                      <span className="truncate">{u.name}</span>
                    </span>
                  </td>
                  <td className="p-2" dir="ltr">
                    {u.phone ?? '—'}
                  </td>
                  <td className="p-2">
                    <Badge role={u.role} size="sm" dot>
                      {t(`roles.${u.role}`)}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={discountAuth[u.id] ? 'success' : 'neutral'} size="sm">
                        {discountAuth[u.id]
                          ? t('staff.discountAuthorizationSet')
                          : t('staff.discountAuthorizationUnset')}
                      </Badge>
                      <Button variant="secondary" size="sm" onClick={() => setDiscountTarget(u)}>
                        <Lock size={16} aria-hidden />
                        {t('staff.setDiscountPassword')}
                      </Button>
                    </span>
                  </td>
                  <td className="p-2">
                    <Badge variant={staffBadgeVariant(u.status)} size="sm" dot>
                      {u.status === 'ACTIVE' ? t('staff.active') : t('staff.suspended')}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <Button
                      variant={u.status === 'ACTIVE' ? 'destructiveGhost' : 'secondary'}
                      size="sm"
                      disabled={u.id === user?.id}
                      onClick={() => toggleStatus(u)}
                    >
                      <Power size={16} aria-hidden />
                      {u.status === 'ACTIVE' ? t('staff.suspend') : t('staff.activate')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <AddStaffDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={refresh} />
      {discountTarget ? (
        <DiscountAuthorizationDialog
          open
          userId={discountTarget.id}
          staffName={discountTarget.name}
          configured={Boolean(discountAuth[discountTarget.id])}
          onClose={() => setDiscountTarget(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  )
}
