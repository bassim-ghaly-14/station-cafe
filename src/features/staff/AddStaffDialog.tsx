/** Add-staff dialog (roles limited to the actor's level; ADMIN-only via backend). */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { call } from '@/services/ipc'
import { useSession } from '../auth/useSession'

export function AddStaffDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const { user } = useSession()
  const toast = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<'STAFF' | 'MANAGER'>('STAFF')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function save() {
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = t('errors.user.name_required')
    if (password.length < 5) errs.password = t('errors.user.password_too_short')
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setBusy(true)
    try {
      await call<number>('create_staff', {
        input: { name: name.trim(), phone: phone.trim() || null, role, password },
      })
      toast(t('staff.created'), 'success')
      setName('')
      setPhone('')
      setPassword('')
      onSaved()
      onClose()
    } catch (e) {
      toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('staff.addStaff')}>
      <div className="flex flex-col gap-4">
        <Field label={t('staff.name')} error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('staff.phone')}>
          <Input value={phone} dir="ltr" onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={t('roles.title')}>
          <select
            className="h-10 w-full rounded-md border border-border-strong bg-surface-input px-3 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as 'STAFF' | 'MANAGER')}
          >
            <option value="STAFF">{t('roles.STAFF')}</option>
            <option value="MANAGER">{t('roles.MANAGER')}</option>
            {user?.role === 'ADMIN' ? <option value="ADMIN">{t('roles.ADMIN')}</option> : null}
          </select>
        </Field>
        <Field label={t('auth.password')} error={errors.password}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {busy ? t('app.loading') : t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
