import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Dialog } from '@/components/ui'
import { Package, RefreshCw, Trash2 } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { developerApi } from '@/services/developerApi'
import { useSession } from '@/features/auth/useSession'

export default function DevSettingsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const { user, clearSessionToken, clearLocalSession } = useSession()
  const [busy, setBusy] = useState<'seed' | 'clear' | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  if (user?.role !== 'ADMIN') return null

  async function loadDemoData() {
    setBusy('seed')
    const reseedToken = developerApi.takeReseedToken()
    try {
      await developerApi.loadDemo(reseedToken)
      if (reseedToken) clearLocalSession()
      toast(t('dev.seedSuccess'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : t('errors.internal_error'), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function clearDatabase() {
    setBusy('clear')
    try {
      const reseedToken = await developerApi.clear()
      developerApi.setReseedToken(reseedToken)
      // The database deleted every session row. Remove stale session-backed
      // state immediately while keeping this ADMIN page available for reseed.
      clearSessionToken()
      setConfirmClear(false)
      toast(t('dev.clearSuccess'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : t('errors.internal_error'), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-heading flex items-center gap-2">
        <Package size={22} />
        {t('dev.title')}
      </h1>

      <Card>
        <CardHeader title={t('dev.seed')} subtitle={t('dev.seedDescription')} />
        <div className="mb-4">
          <Button loading={busy !== null} onClick={() => void loadDemoData()}>
            <RefreshCw size={16} aria-hidden />
            {t('dev.seed')}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('dev.clear')} subtitle={t('dev.clearDescription')} />
        <Button
          variant="destructive"
          loading={busy !== null}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={16} aria-hidden />
          {t('dev.clear')}
        </Button>
      </Card>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={t('dev.clearConfirmationTitle')}
      >
        <div className="flex flex-col gap-4">
          <div className="whitespace-pre-line text-sm leading-6">
            {t('dev.clearWarning')}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              {t('app.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={busy === 'clear'}
              onClick={() => void clearDatabase()}
            >
              {t('dev.clear')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

