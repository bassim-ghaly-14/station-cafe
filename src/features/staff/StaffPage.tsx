/** Staff management (MANAGER+). Create staff, set status, assign roles. */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Card, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Plus, Power } from '@/components/ui/icon'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { useToast } from '@/components/ui/toast'
import { call } from '@/services/ipc'
import { useSession, type User } from '../auth/useSession'
import { AddStaffDialog } from './AddStaffDialog'

export default function StaffPage() {
  const { t } = useTranslation()
  const { user } = useSession()
  const toast = useToast()
  const [staff, setStaff] = useState<User[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const refresh = useCallback(() => {
    setStaff(null)
    setError(null)
    call<User[]>('list_staff')
      .then(setStaff)
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
          <LoadingState label={t('app.loading')} />
        ) : staff.length === 0 ? (
          <EmptyState title={t('staff.empty')} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-foreground-subtle">
                <th className="p-2 font-medium">{t('staff.name')}</th>
                <th className="p-2 font-medium">{t('staff.phone')}</th>
                <th className="p-2 font-medium">{t('roles.title')}</th>
                <th className="p-2 font-medium">{t('app.status')}</th>
                <th className="p-2 font-medium">{t('app.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <tr key={u.id} className="border-b border-border-subtle">
                  <td className="p-2 font-medium text-foreground-strong">{u.name}</td>
                  <td className="p-2" dir="ltr">
                    {u.phone ?? '—'}
                  </td>
                  <td className="p-2">
                    <Badge
                      tone={
                        u.role === 'ADMIN' ? 'danger' : u.role === 'MANAGER' ? 'info' : 'neutral'
                      }
                    >
                      {t(`roles.${u.role}`)}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <Badge tone={u.status === 'ACTIVE' ? 'success' : 'warning'}>
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
    </div>
  )
}
