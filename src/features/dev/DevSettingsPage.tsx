import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Dialog, Field, Input, PasswordInput } from '@/components/ui'
import { ArrowRight, Minus, Package, Plus, RefreshCw, Trash2 } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { api, settingsApi, type CreditConfig } from '@/services/posApi'
import { developerApi } from '@/services/developerApi'
import { useErrText } from '@/lib/err'
import { useSession } from '@/features/auth/useSession'

export default function DevSettingsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const { user, clearSessionToken, clearLocalSession } = useSession()

  const [serviceAmounts, setServiceAmounts] = useState<string[]>([])
  const [discountPassword, setDiscountPassword] = useState('')
  const [discountConfigured, setDiscountConfigured] = useState(false)

  const [credit, setCredit] = useState<CreditConfig>({
    enabled: true,
    mode: 'LIST',
    allowed_customer_ids: [],
  })

  const [tableCount, setTableCount] = useState(12)
  const [savedTableCount, setSavedTableCount] = useState(12)

  const [busy, setBusy] = useState<'settings' | 'tables' | 'seed' | 'clear' | null>(null)

  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    if (user?.role !== 'ADMIN') return

    void Promise.all([
      settingsApi.serviceCharge(),
      settingsApi.discountAuthorization(),
      settingsApi.credit(),
      api.tables(),
    ])
      .then(([serviceCharge, authorization, creditConfig, tables]) => {
        setServiceAmounts(serviceCharge.amounts.map((amount) => String(amount / 100)))
        setDiscountConfigured(authorization.configured)
        setCredit(creditConfig)
        setTableCount(tables.length)
        setSavedTableCount(tables.length)
      })
      .catch((error) => toast(errText(error), 'error'))
  }, [user?.role, toast, errText])

  if (user?.role !== 'ADMIN') return null

  async function saveSettings() {
    setBusy('settings')

    try {
      const amounts = serviceAmounts.map((value) => Math.round(Number(value) * 100))

      if (
        serviceAmounts.some((value) => value.trim() === '' || !Number.isFinite(Number(value))) ||
        amounts.some((value) => value <= 0) ||
        new Set(amounts).size !== amounts.length
      ) {
        throw new Error('settings.invalid_service_charge')
      }

      await Promise.all([
        settingsApi.setServiceCharge({ amounts }),
        discountPassword
          ? settingsApi.setDiscountAuthorizationPassword(discountPassword)
          : Promise.resolve(),
        settingsApi.setCredit(credit),
      ])

      setDiscountPassword('')
      setDiscountConfigured(true)

      toast(t('dev.settingsSaved'), 'success')
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function applyTableCount() {
    setBusy('tables')

    try {
      await api.setTableCount(tableCount)
      setSavedTableCount(tableCount)

      toast(t('dev.tableCountSaved'), 'success')
    } catch (error) {
      setTableCount(savedTableCount)
      toast(errText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function loadOfficialData() {
    setBusy('seed')

    const reseedToken = developerApi.takeReseedToken()

    try {
      await developerApi.loadOfficial(reseedToken)

      if (reseedToken) {
        developerApi.clearReseedToken()
        clearLocalSession()
      }

      toast(t('dev.seedSuccess'), 'success')
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function clearDatabase() {
    setBusy('clear')

    try {
      const reseedToken = await developerApi.clear()

      developerApi.setReseedToken(reseedToken)
      clearSessionToken()
      setConfirmClear(false)

      toast(t('dev.clearSuccess'), 'success')
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const tableCountChanged = tableCount !== savedTableCount

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-heading flex items-center gap-2">
        <Package size={22} />
        {t('dev.title')}
      </h1>

      <Card>
        <CardHeader title={t('dev.operations')} subtitle={t('dev.operationsDescription')} />

        <div className="grid gap-4 md:grid-cols-2">
          {/* Service charge amounts */}
          <div className="flex flex-col gap-3 md:col-span-2">
            <h3 className="font-bold text-foreground">{t('dev.serviceCharge')}</h3>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {serviceAmounts.map((amount, index) => (
                <div key={index} className="flex min-w-0 items-center gap-2">
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    aria-label={`${t('dev.serviceCharge')} ${index + 1}`}
                    value={amount}
                    className="w-24 min-w-0 flex-none"
                    onChange={(e) =>
                      setServiceAmounts((values) =>
                        values.map((value, current) =>
                          current === index ? e.target.value : value,
                        ),
                      )
                    }
                  />

                  <Button
                    size="icon"
                    variant="outline"
                    disabled={index === 0}
                    aria-label={t('dev.moveUp')}
                    onClick={() =>
                      setServiceAmounts((values) => {
                        const next = [...values]

                        ;[next[index - 1], next[index]] = [next[index], next[index - 1]]

                        return next
                      })
                    }
                  >
                    <ArrowRight size={16} aria-hidden className="rotate-90" />
                  </Button>

                  <Button
                    size="icon"
                    variant="outline"
                    disabled={index === serviceAmounts.length - 1}
                    aria-label={t('dev.moveDown')}
                    onClick={() =>
                      setServiceAmounts((values) => {
                        const next = [...values]

                        ;[next[index], next[index + 1]] = [next[index + 1], next[index]]

                        return next
                      })
                    }
                  >
                    <ArrowRight size={16} aria-hidden className="-rotate-90" />
                  </Button>

                  <Button
                    size="icon"
                    variant="destructiveGhost"
                    aria-label={t('dev.removeAmount')}
                    onClick={() =>
                      setServiceAmounts((values) => values.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2 size={16} aria-hidden />
                  </Button>
                </div>
              ))}
            </div>

            <Button
              variant="outline"
              className="self-start"
              onClick={() => setServiceAmounts((values) => [...values, ''])}
            >
              <Plus size={16} aria-hidden />
              {t('dev.addAmount')}
            </Button>
          </div>

          {/* Discount password */}
          <Field label={t('dev.discountPassword')} htmlFor="discount-authorization-password">
            <PasswordInput
              id="discount-authorization-password"
              autoComplete="new-password"
              value={discountPassword}
              placeholder={discountConfigured ? t('dev.passwordConfigured') : ''}
              onChange={(e) => setDiscountPassword(e.target.value)}
            />
          </Field>

          {/* Credit settings */}
          <div className="flex flex-col gap-3 md:col-span-2">
            <h3 className="font-bold text-foreground">{t('dev.credit')}</h3>

            {/* Credit policy + enabled switch */}
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('dev.creditPolicy')}>
                <select
                  className="
                    h-10 w-full rounded-md
                    border border-border-strong
                    bg-surface px-3
                    text-foreground
                    focus-visible:outline-2
                    focus-visible:outline-offset-1
                    focus-visible:outline-focus
                  "
                  value={credit.mode}
                  onChange={(e) =>
                    setCredit({
                      ...credit,
                      mode: e.target.value as CreditConfig['mode'],
                    })
                  }
                >
                  <option value="LIST">{t('dev.list')}</option>
                  <option value="ALL">{t('dev.all')}</option>
                </select>
              </Field>

              <Field label={t('dev.creditEnabled')}>
                <div className="flex h-10 items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={credit.enabled}
                    aria-label={t('dev.creditEnabled')}
                    onClick={() =>
                      setCredit((current) => ({
                        ...current,
                        enabled: !current.enabled,
                      }))
                    }
                    className={`
                      relative h-7 w-12 shrink-0
                      cursor-pointer rounded-full border
                      transition-all duration-200
                      focus-visible:outline-2
                      focus-visible:outline-offset-2
                      focus-visible:outline-focus
                      ${
                        credit.enabled
                          ? 'border-accent bg-accent'
                          : 'border-border-strong bg-surface-muted'
                      }
                    `}
                  >
                    <span
                      aria-hidden="true"
                      className={`
                        absolute top-1/2
                        h-5 w-5
                        -translate-y-1/2
                        rounded-full
                        shadow-sm
                        transition-all duration-200
                        ${credit.enabled ? 'inset-s-6 bg-foreground-muted' : 'inset-s-1 bg-accent'}
                      `}
                    />
                  </button>

                  <span
                    className={`
                      text-sm font-semibold
                      transition-colors duration-200
                      ${credit.enabled ? 'text-foreground-muted' : 'text-accent'}
                    `}
                  >
                    {credit.enabled ? t('app.enabled') : t('app.disabled')}
                  </span>
                </div>
              </Field>
            </div>
          </div>
        </div>

        <Button className="mt-4" loading={busy === 'settings'} onClick={() => void saveSettings()}>
          {t('dev.save')}
        </Button>
      </Card>

      {/* Tables */}
      <Card>
        <CardHeader title={t('dev.tables')} subtitle={t('dev.tableCountHelp')} />

        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="outline"
            disabled={tableCount <= 1}
            aria-label={t('dev.decrease')}
            onClick={() => setTableCount((count) => Math.max(1, count - 1))}
          >
            <Minus size={18} aria-hidden />
          </Button>

          <output
            className="min-w-16 text-center text-3xl font-bold"
            aria-label={t('dev.tableCount')}
          >
            {tableCount}
          </output>

          <Button
            size="icon"
            variant="outline"
            disabled={tableCount >= 99}
            aria-label={t('dev.increase')}
            onClick={() => setTableCount((count) => Math.min(99, count + 1))}
          >
            <Plus size={18} aria-hidden />
          </Button>

          <Button
            disabled={!tableCountChanged}
            loading={busy === 'tables'}
            onClick={() => void applyTableCount()}
          >
            {t('app.save')}
          </Button>
        </div>
      </Card>

      {/* Official data */}
      <Card>
        <CardHeader title={t('dev.seed')} subtitle={t('dev.seedDescription')} />

        <Button loading={busy === 'seed'} onClick={() => void loadOfficialData()}>
          <RefreshCw size={16} aria-hidden />
          {t('dev.seed')}
        </Button>
      </Card>

      {/* Clear database */}
      <Card>
        <CardHeader title={t('dev.clear')} subtitle={t('dev.clearDescription')} />

        <Button
          variant="destructive"
          loading={busy === 'clear'}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={16} aria-hidden />
          {t('dev.clear')}
        </Button>
      </Card>

      {/* Clear confirmation */}
      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={t('dev.clearConfirmationTitle')}
      >
        <div className="flex flex-col gap-4">
          <div className="whitespace-pre-line text-sm leading-6">{t('dev.clearWarning')}</div>

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
