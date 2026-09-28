import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  Field,
  Select,
  Switch,
  isValidDiscountPin,
} from '@/components/ui'
import {
  Lock,
  Minus,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
} from '@/components/ui/icon'
import { DevAmountList } from './DevAmountList'
import { DevDiscountPinDialog } from './DevDiscountPinDialog'
import { useToast } from '@/components/ui/toast'
import { api, settingsApi, MONTHLY_SALES_PERIOD_MONTHS, type CreditConfig } from '@/services/posApi'
import { developerApi } from '@/services/developerApi'
import { useErrText } from '@/lib/err'
import {
  COMPACT_THRESHOLD_OPTIONS,
  DATE_FORMAT_OPTIONS,
  cloneFormattingPreferences,
  defaultFormattingPreferences,
  formattingPreferencesEqual,
  replaceFormattingPreferences,
  useFormattingPreferences,
  type FormattingPreferences,
} from '@/lib/formatting'
import { useSession } from '@/features/auth/useSession'
import { ChartColorsCard } from './ChartColorsCard'
import { LocalAccessCard } from './LocalAccessCard'
import { FormattingPreview } from './FormattingPreview'

/** Shared control styling for the formatting selects. */
const SELECT =
  'h-10 w-full rounded-md border border-border-strong bg-surface-input px-3 text-foreground focus-visible:outline-2 focus-visible:outline-focus'

/**
 * Turn a list of typed-in amounts into the minor-unit integers the backend
 * stores, or refuse it.
 *
 * The rule is the same for service charges and discount options, so it is
 * written once: every entry must be a real number, greater than zero, and
 * distinct. Distinctness matters because these lists drive quick-pick buttons —
 * two identical options would render as two buttons doing the same thing.
 *
 * `invalidCode` is what the manager is told, so the caller keeps ownership of
 * which setting failed rather than this function guessing.
 */
function parseAmountList(
  values: readonly string[],
  invalidCode: 'settings.invalid_service_charge' | 'settings.invalid_discount',
): { amounts: number[] } | { error: string } {
  const amounts = values.map((value) => Math.round(Number(value) * 100))
  const blank = values.some((value) => value.trim() === '' || !Number.isFinite(Number(value)))
  const nonPositive = amounts.some((value) => value <= 0)
  const duplicated = new Set(amounts).size !== amounts.length
  if (blank || nonPositive || duplicated) return { error: invalidCode }
  return { amounts }
}

export default function DevSettingsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const { user, clearSessionToken, clearLocalSession } = useSession()

  const [serviceAmounts, setServiceAmounts] = useState<string[]>([])
  const [discountAmounts, setDiscountAmounts] = useState<string[]>([])

  const [credit, setCredit] = useState<CreditConfig>({
    enabled: true,
    mode: 'LIST',
    allowed_customer_ids: [],
  })

  const [tableCount, setTableCount] = useState(12)
  const [savedTableCount, setSavedTableCount] = useState(12)

  // The monthly sales chart window: a cafe setting like any other, edited here
  // and read by the Sales page through `settingsApi`.
  const [monthlyPeriod, setMonthlyPeriod] = useState<number>(MONTHLY_SALES_PERIOD_MONTHS[1])
  const [savedMonthlyPeriod, setSavedMonthlyPeriod] = useState<number>(
    MONTHLY_SALES_PERIOD_MONTHS[1],
  )

  // The ONE shared discount-authorization PIN: a global cafe setting.
  const [discountPinConfigured, setDiscountPinConfigured] = useState(false)
  const [pinDialogOpen, setPinDialogOpen] = useState(false)
  const [pinDraft, setPinDraft] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)

  const [busy, setBusy] = useState<
    'settings' | 'tables' | 'seed' | 'clear' | 'pin' | 'period' | null
  >(null)

  const [confirmClear, setConfirmClear] = useState(false)

  // ── Display formatting: draft vs saved ────────────────────────────────────
  // Controls edit a local DRAFT. Only "Save Changes" commits it to the central
  // store, so experimenting never changes the rest of the application.
  const saved = useFormattingPreferences()

  const [draft, setDraft] = useState<FormattingPreferences>(() => cloneFormattingPreferences(saved))

  const formattingDirty = !formattingPreferencesEqual(draft, saved)

  const patchDraft = useCallback(
    (patch: {
      money?: Partial<FormattingPreferences['money']>
      date?: Partial<FormattingPreferences['date']>
    }) => {
      setDraft((current) => ({
        ...current,
        money: { ...current.money, ...patch.money },
        date: { ...current.date, ...patch.date },
      }))
    },
    [],
  )

  const saveFormatting = () => {
    replaceFormattingPreferences(draft)

    // Re-base the draft on a detached copy so later edits never alias the store.
    setDraft(cloneFormattingPreferences(draft))

    toast(t('dev.formattingSaved'), 'success')
  }

  const resetDraft = () => {
    setDraft(cloneFormattingPreferences(saved))
  }

  // Defaults land in the DRAFT, not the store.
  const loadDefaultsIntoDraft = () => {
    setDraft(defaultFormattingPreferences())
  }

  // Loads every setting displayed on this page.
  const loadSettings = useCallback(async () => {
    const [
      serviceCharge,
      discountOptions,
      discountAuthorization,
      creditConfig,
      tables,
      monthlySalesPeriod,
    ] = await Promise.all([
      settingsApi.serviceCharge(),
      settingsApi.discountOptions(),
      settingsApi.discountAuthorization().catch(() => ({ configured: false })),
      settingsApi.credit(),
      api.tables(),
      settingsApi.monthlySalesPeriod().catch(() => ({ months: MONTHLY_SALES_PERIOD_MONTHS[1] })),
    ])

    setServiceAmounts(serviceCharge.amounts.map((amount) => String(amount / 100)))
    setDiscountAmounts(discountOptions.amounts.map((amount) => String(amount / 100)))
    setDiscountPinConfigured(discountAuthorization.configured)
    setCredit(creditConfig)
    setTableCount(tables.length)
    setSavedTableCount(tables.length)
    setMonthlyPeriod(monthlySalesPeriod.months)
    setSavedMonthlyPeriod(monthlySalesPeriod.months)
  }, [])

  useEffect(() => {
    if (user?.role !== 'ADMIN') return

    void loadSettings().catch((error) => toast(errText(error), 'error'))
  }, [user?.role, loadSettings, toast, errText])

  if (user?.role !== 'ADMIN') return null

  async function saveSettings() {
    setBusy('settings')

    try {
      // Discount options are configuration, not a sale; the two lists are
      // validated by the same rule but refused with different codes, so a
      // manager can tell which one the backend rejected.
      const service = parseAmountList(serviceAmounts, 'settings.invalid_service_charge')
      if ('error' in service) throw new Error(service.error)

      const discount = parseAmountList(discountAmounts, 'settings.invalid_discount')
      if ('error' in discount) throw new Error(discount.error)

      await Promise.all([
        settingsApi.setServiceCharge({ amounts: service.amounts }),
        settingsApi.setDiscountOptions({ amounts: discount.amounts }),
        settingsApi.setCredit(credit),
      ])

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

  /**
   * Persist the monthly sales chart window.
   *
   * Same lifecycle as the table count: an explicit save, a revert to the last
   * saved value if the backend refuses, and a toast either way. The server owns
   * the accepted set, so the select can only ever offer what it will store.
   */
  async function applyMonthlyPeriod() {
    setBusy('period')

    try {
      await settingsApi.setMonthlySalesPeriod({ months: monthlyPeriod })
      setSavedMonthlyPeriod(monthlyPeriod)

      toast(t('dev.monthlySalesPeriodSaved'), 'success')
    } catch (error) {
      setMonthlyPeriod(savedMonthlyPeriod)
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

      // The grant is single-use.
      if (reseedToken) {
        developerApi.clearReseedToken()
        clearLocalSession()
      }

      // Reload settings because products/tables may have changed.
      await loadSettings().catch(() => {
        // Seed succeeded; refresh failure should not report seed failure.
      })

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

      // Keep the one-time reseed grant so "Load Official Data" can still
      // be used before signing in again.
      developerApi.setReseedToken(reseedToken)

      clearSessionToken()
      setConfirmClear(false)

      // Reset local UI state immediately so no stale values remain visible.
      setServiceAmounts([])
      setDiscountAmounts([])
      setDiscountPinConfigured(false)
      setCredit({
        enabled: false,
        mode: 'LIST',
        allowed_customer_ids: [],
      })
      setTableCount(0)
      setSavedTableCount(0)
      setMonthlyPeriod(MONTHLY_SALES_PERIOD_MONTHS[1])
      setSavedMonthlyPeriod(MONTHLY_SALES_PERIOD_MONTHS[1])

      toast(t('dev.clearSuccess'), 'success')
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const tableCountChanged = tableCount !== savedTableCount
  const monthlyPeriodChanged = monthlyPeriod !== savedMonthlyPeriod

  /**
   * Set/change the ONE shared 4-digit discount PIN.
   *
   * The PIN is write-only: it is sent once, hashed by the backend, and never
   * read back. This screen only shows whether one is configured.
   */
  async function saveDiscountPin() {
    if (!isValidDiscountPin(pinDraft)) {
      setPinError(t('errors.discount.invalid_pin'))
      return
    }

    setBusy('pin')
    setPinError(null)

    try {
      await settingsApi.setDiscountPin(pinDraft)

      setPinDraft('')
      setPinDialogOpen(false)
      setDiscountPinConfigured(true)

      toast(t('dev.discountPinSaved'), 'success')
    } catch (error) {
      setPinError(errText(error))
    } finally {
      setBusy(null)
    }
  }

  /** Closing the PIN dialog always discards the draft, never keeps it. */
  function closePinDialog() {
    setPinDraft('')
    setPinError(null)
    setPinDialogOpen(false)
  }

  /** Typing a new entry clears the complaint about the previous one. */
  function handlePinDraft(next: string) {
    setPinDraft(next)
    setPinError(null)
  }

  return (
    /* Steps down to `gap-4` on a phone — see the note in `CatalogPage`. */
    <div className="flex flex-col gap-4 sm:gap-6">
      {/* Page header */}
      <header className="flex flex-col gap-1">
        <h1 className="text-heading flex items-center gap-2">
          <Package size={22} />
          {t('dev.title')}
        </h1>

        <p className="text-sm text-foreground-muted">{t('dev.subtitle')}</p>
      </header>

      {/* General settings */}
      <Card>
        <CardHeader title={t('dev.operations')} subtitle={t('dev.operationsDescription')} />

        <div className="grid gap-4 md:grid-cols-2">
          {/* Service charge amounts */}
          <div className="flex flex-col gap-3 md:col-span-2">
            <h3 className="font-bold text-foreground">{t('dev.serviceCharge')}</h3>

            <DevAmountList
              className="flex flex-col gap-3"
              label={t('dev.serviceCharge')}
              amounts={serviceAmounts}
              onChange={setServiceAmounts}
              addLabel={t('dev.addAmount')}
              removeLabel={t('dev.removeAmount')}
              reorderable
            />
          </div>

          {/* Discount quick-picks */}
          <div className="flex flex-col gap-3 md:col-span-2">
            <h3 className="font-bold text-foreground">{t('dev.discountOptions')}</h3>

            <p className="text-sm text-foreground-muted">{t('dev.discountOptionsHelp')}</p>

            <DevAmountList
              className="flex flex-col gap-3"
              label={t('dev.discountOptions')}
              amounts={discountAmounts}
              onChange={setDiscountAmounts}
              addLabel={t('dev.addDiscountAmount')}
              removeLabel={t('dev.removeDiscountAmount')}
            />
          </div>

          {/* Shared discount PIN */}
          <div className="flex flex-col gap-3 md:col-span-2">
            <h3 className="font-bold text-foreground">{t('dev.discountPin')}</h3>

            <p className="text-sm text-foreground-muted">{t('dev.discountPinHelp')}</p>

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={discountPinConfigured ? 'success' : 'neutral'} size="sm" dot>
                {discountPinConfigured
                  ? t('dev.discountPinConfigured')
                  : t('dev.discountPinUnconfigured')}
              </Badge>

              <Button
                variant="secondary"
                onClick={() => {
                  setPinError(null)
                  setPinDialogOpen(true)
                }}
              >
                <Lock size={16} aria-hidden />
                {discountPinConfigured ? t('dev.changeDiscountPin') : t('dev.setDiscountPin')}
              </Button>
            </div>
          </div>

          {/* Credit settings */}
          <div className="flex flex-col gap-3 md:col-span-2">
            <h3 className="font-bold text-foreground">{t('dev.credit')}</h3>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t('dev.creditPolicy')}>
                <select
                  className="
                    h-10 w-full rounded-md
                    border border-border-strong
                    bg-surface-input px-3
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
                  <Switch
                    tone="state"
                    checked={credit.enabled}
                    onCheckedChange={(enabled) =>
                      setCredit((current) => ({
                        ...current,
                        enabled,
                      }))
                    }
                    label={t('dev.creditEnabled')}
                  />

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

      {/* Chart bar colours — one card, one store, every chart in the app. */}
      <ChartColorsCard />
      <LocalAccessCard />

      {/* Global display formatting */}
      <Card>
        <CardHeader
          title={t('dev.displayFormatting')}
          subtitle={t('dev.displayFormattingDescription')}
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          {/* Right side: formatting controls */}
          <div className="flex min-w-0 flex-col gap-6 lg:order-2">
            {/* Money formatting */}
            <section className="flex flex-col gap-4">
              <h3 className="font-bold text-foreground">{t('dev.moneyFormatting')}</h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('dev.decimalPlaces')}>
                  <select
                    aria-label={t('dev.decimalPlaces')}
                    className={SELECT}
                    value={draft.money.decimalPlaces}
                    onChange={(e) =>
                      patchDraft({
                        money: {
                          decimalPlaces: Number(e.target.value) as 0 | 1 | 2,
                        },
                      })
                    }
                  >
                    <option value="0">0</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                  </select>
                </Field>

                <Field label={t('dev.currencyPosition')}>
                  <select
                    aria-label={t('dev.currencyPosition')}
                    className={SELECT}
                    value={draft.money.currencyPosition}
                    onChange={(e) =>
                      patchDraft({
                        money: {
                          currencyPosition: e.target.value as 'after' | 'before',
                        },
                      })
                    }
                  >
                    <option value="after">{t('dev.currencyAfter')}</option>
                    <option value="before">{t('dev.currencyBefore')}</option>
                  </select>
                </Field>

                <Field label={t('dev.compactThreshold')} hint={t('dev.compactThresholdHelp')}>
                  <select
                    aria-label={t('dev.compactThreshold')}
                    className={SELECT}
                    value={draft.money.compactThreshold}
                    onChange={(e) =>
                      patchDraft({
                        money: {
                          compactThreshold: Number(e.target.value),
                        },
                      })
                    }
                  >
                    {COMPACT_THRESHOLD_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {value.toLocaleString('en-US')}
                      </option>
                    ))}
                  </select>
                </Field>

                {/* Thousands separator */}
                <Field label={t('dev.thousandsSeparator')}>
                  <div className="flex h-10 items-center gap-3">
                    <Switch
                      tone="state"
                      checked={draft.money.useThousandsSeparator}
                      onCheckedChange={(useThousandsSeparator) =>
                        patchDraft({
                          money: {
                            useThousandsSeparator,
                          },
                        })
                      }
                      label={t('dev.thousandsSeparator')}
                    />

                    <span
                      className={`
                        text-sm font-semibold
                        transition-colors duration-200
                        ${
                          draft.money.useThousandsSeparator
                            ? 'text-foreground-muted'
                            : 'text-accent'
                        }
                      `}
                    >
                      {draft.money.useThousandsSeparator ? t('app.enabled') : t('app.disabled')}
                    </span>
                  </div>
                </Field>

                {/* Show currency */}
                <Field label={t('dev.showCurrency')}>
                  <div className="flex h-10 items-center gap-3">
                    <Switch
                      tone="state"
                      checked={draft.money.showCurrency}
                      onCheckedChange={(showCurrency) =>
                        patchDraft({
                          money: {
                            showCurrency,
                          },
                        })
                      }
                      label={t('dev.showCurrency')}
                    />

                    <span
                      className={`
                        text-sm font-semibold
                        transition-colors duration-200
                        ${draft.money.showCurrency ? 'text-foreground-muted' : 'text-accent'}
                      `}
                    >
                      {draft.money.showCurrency ? t('app.enabled') : t('app.disabled')}
                    </span>
                  </div>
                </Field>

                {/* Compact values */}
                <Field label={t('dev.compactValues')}>
                  <div className="flex h-10 items-center gap-3">
                    <Switch
                      tone="state"
                      checked={draft.money.compactLargeValues}
                      onCheckedChange={(compactLargeValues) =>
                        patchDraft({
                          money: {
                            compactLargeValues,
                          },
                        })
                      }
                      label={t('dev.compactValues')}
                    />

                    <span
                      className={`
                        text-sm font-semibold
                        transition-colors duration-200
                        ${draft.money.compactLargeValues ? 'text-foreground-muted' : 'text-accent'}
                      `}
                    >
                      {draft.money.compactLargeValues ? t('app.enabled') : t('app.disabled')}
                    </span>
                  </div>
                </Field>
              </div>
            </section>

            {/* Date & time formatting */}
            <section className="flex flex-col gap-4 border-t border-border pt-6">
              <h3 className="font-bold text-foreground">{t('dev.dateTimeFormatting')}</h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('dev.dateFormat')}>
                  <select
                    aria-label={t('dev.dateFormat')}
                    className={SELECT}
                    value={draft.date.dateFormat}
                    onChange={(e) =>
                      patchDraft({
                        date: {
                          dateFormat: e.target.value as FormattingPreferences['date']['dateFormat'],
                        },
                      })
                    }
                  >
                    {DATE_FORMAT_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label={t('dev.timeFormat')}>
                  <select
                    aria-label={t('dev.timeFormat')}
                    className={SELECT}
                    value={draft.date.timeFormat}
                    onChange={(e) =>
                      patchDraft({
                        date: {
                          timeFormat: e.target.value as '12h' | '24h',
                        },
                      })
                    }
                  >
                    <option value="24h">24h</option>
                    <option value="12h">12h</option>
                  </select>
                </Field>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Field label={t('dev.showSeconds')}>
                    <div className="flex h-10 items-center gap-3">
                      <Switch
                        tone="state"
                        checked={draft.date.showSeconds}
                        onCheckedChange={(showSeconds) =>
                          patchDraft({
                            date: {
                              showSeconds,
                            },
                          })
                        }
                        label={t('dev.showSeconds')}
                      />

                      <span
                        className={`
                          text-sm font-semibold
                          transition-colors duration-200
                          ${draft.date.showSeconds ? 'text-foreground-muted' : 'text-accent'}
                        `}
                      >
                        {draft.date.showSeconds ? t('app.enabled') : t('app.disabled')}
                      </span>
                    </div>
                  </Field>
                </div>
              </div>
            </section>
          </div>

          {/* Left side: live preview */}
          <section className="flex min-w-0 flex-col gap-4 lg:order-1 lg:border-s lg:border-border lg:pe-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex flex-wrap items-center gap-2 font-bold text-foreground">
                {t('dev.preview')}

                {formattingDirty ? (
                  <Badge
                    data-testid="formatting-dirty"
                    variant="warning"
                    size="sm"
                    shape="pill"
                    dot
                  >
                    {t('dev.unsavedChanges')}
                  </Badge>
                ) : null}
              </h3>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={resetDraft}
                  disabled={!formattingDirty}
                  data-testid="formatting-reset-draft"
                >
                  <RotateCcw size={16} aria-hidden />
                  {t('dev.resetChanges')}
                </Button>

                <Button
                  variant="outline"
                  onClick={loadDefaultsIntoDraft}
                  data-testid="formatting-load-defaults"
                >
                  {t('dev.resetFormatting')}
                </Button>

                <Button
                  onClick={saveFormatting}
                  disabled={!formattingDirty}
                  data-testid="formatting-save"
                >
                  <Save size={16} aria-hidden />
                  {t('dev.saveFormatting')}
                </Button>
              </div>
            </div>

            <FormattingPreview draft={draft} />
          </section>
        </div>
      </Card>

      {/* Tables */}
      <Card data-testid="dev-tables">
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

      {/* Monthly sales chart window */}
      <Card data-testid="dev-monthly-period">
        <CardHeader
          title={t('dev.monthlySalesPeriod')}
          subtitle={t('dev.monthlySalesPeriodHelp')}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <Field label={t('dev.monthlySalesPeriodMonths')}>
              <Select
                aria-label={t('dev.monthlySalesPeriodMonths')}
                value={String(monthlyPeriod)}
                onChange={(event) => setMonthlyPeriod(Number(event.target.value))}
              >
                {MONTHLY_SALES_PERIOD_MONTHS.map((months) => (
                  <option key={months} value={months}>
                    {t('dev.monthsOption', { count: months })}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Button
            disabled={!monthlyPeriodChanged}
            loading={busy === 'period'}
            onClick={() => void applyMonthlyPeriod()}
          >
            {t('app.save')}
          </Button>
        </div>
      </Card>

      {/* Danger zone */}
      <section
        aria-labelledby="dev-danger-zone"
        data-testid="dev-danger-zone"
        className="flex flex-col gap-4 rounded-lg border border-destructive-border bg-destructive-soft/40 p-4"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="dev-danger-zone"
            className="flex items-center gap-2 text-base font-bold text-destructive-soft-foreground"
          >
            <TriangleAlert size={18} aria-hidden />
            {t('dev.dangerZone')}
          </h2>

          <p className="text-xs text-foreground-subtle">{t('dev.dangerZoneDescription')}</p>
        </div>

        {/* Load official data */}
        <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <RefreshCw size={18} aria-hidden className="mt-0.5 shrink-0 text-foreground-muted" />

            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground-strong">
                {t('dev.dangerZoneLoadTitle')}
              </h3>

              <p className="text-xs text-foreground-muted">{t('dev.dangerZoneLoadDescription')}</p>
            </div>
          </div>

          <Button
            className="shrink-0 self-start sm:self-auto"
            loading={busy === 'seed'}
            disabled={busy !== null}
            onClick={() => void loadOfficialData()}
          >
            <RefreshCw size={16} aria-hidden />
            {t('dev.dangerZoneLoadTitle')}
          </Button>
        </div>

        {/* Clear database */}
        <div className="flex flex-col gap-3 rounded-md border border-destructive-border bg-surface-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Trash2 size={18} aria-hidden className="mt-0.5 shrink-0 text-destructive" />

            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground-strong">
                {t('dev.dangerZoneClearTitle')}
              </h3>

              <p className="text-xs text-foreground-muted">{t('dev.dangerZoneClearDescription')}</p>
            </div>
          </div>

          <Button
            className="shrink-0 self-start sm:self-auto"
            variant="destructive"
            loading={busy === 'clear'}
            disabled={busy !== null}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={16} aria-hidden />
            {t('dev.dangerZoneClearTitle')}
          </Button>
        </div>
      </section>

      {/* Clear confirmation */}
      <Dialog
        open={confirmClear}
        onClose={() => {
          if (busy !== 'clear') setConfirmClear(false)
        }}
        title={t('dev.clearConfirmationTitle')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-6 text-foreground">{t('dev.clearWarning')}</p>

          <p className="text-xs leading-5 text-foreground-muted">{t('dev.clearNextStep')}</p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy === 'clear'}
              onClick={() => setConfirmClear(false)}
            >
              {t('dev.dangerZoneCancelLabel')}
            </Button>

            <Button
              variant="destructive"
              loading={busy === 'clear'}
              disabled={busy !== null}
              onClick={() => void clearDatabase()}
            >
              <Trash2 size={16} aria-hidden />
              {t('dev.dangerZoneConfirmLabel')}
            </Button>
          </div>
        </div>
      </Dialog>

      <DevDiscountPinDialog
        open={pinDialogOpen}
        value={pinDraft}
        error={pinError}
        busy={busy === 'pin'}
        onClose={closePinDialog}
        onValueChange={handlePinDraft}
        onSubmit={() => void saveDiscountPin()}
      />
    </div>
  )
}
