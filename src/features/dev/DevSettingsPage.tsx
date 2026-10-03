import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  isValidDiscountPin,
} from '@/components/ui'
import { Package, Sparkles, Trash2 } from '@/components/ui/icon'
import { DevAmountList } from './DevAmountList'
import { DevCreditSettings } from './DevCreditSettings'
import { DevDangerZone, type DevSettingsBusy } from './DevDangerZone'
import { DevDiscountPinDialog } from './DevDiscountPinDialog'
import { DevDiscountPinSettings } from './DevDiscountPinSettings'
import { DevMonthlySalesPeriodCard } from './DevMonthlySalesPeriodCard'
import { DevTableCountCard } from './DevTableCountCard'
import { DevWorkDurationCard } from './DevWorkDurationCard'
import { DisplayFormattingCard } from './DisplayFormattingCard'
import { useToast } from '@/components/ui/toast'
import { api, settingsApi, MONTHLY_SALES_PERIOD_MONTHS, type CreditConfig } from '@/services/posApi'
import { developerApi } from '@/services/developerApi'
import { useErrText } from '@/lib/err'
import { useSession } from '@/features/auth/useSession'
import { ChartColorsCard } from './ChartColorsCard'
import { LocalAccessCard } from './LocalAccessCard'
import { ApplicationUpdatesCard } from './ApplicationUpdatesCard'
import { RevenueTargetsCard } from './RevenueTargetsCard'
import { canOpenDevSettings, canSeeDevSection, loadsAdminSettings } from './devSectionAccess'

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

/**
 * The two amount lists either BOTH parse or the save is refused: one rule, one
 * outcome, so a manager is never left guessing which list the backend meant.
 */
function requireAmounts(
  values: readonly string[],
  invalidCode: 'settings.invalid_service_charge' | 'settings.invalid_discount',
): number[] {
  const parsed = parseAmountList(values, invalidCode)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.amounts
}

/**
 * A confirmation dialog cannot be dismissed while its OWN action is running:
 * closing it mid-request would leave the operator with no record of what they
 * asked for. Both destructive dialogs obey the same rule.
 */
function closeWhenIdle(busy: DevSettingsBusy, action: DevSettingsBusy, close: () => void) {
  if (busy === action) return
  close()
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

  const [busy, setBusy] = useState<DevSettingsBusy>(null)

  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDemo, setConfirmDemo] = useState(false)

  // Loads every setting DISPLAYED on this page.
  //
  // The ADMIN-only reads (table count, monthly chart window) are conditional:
  // those controls exist only for an ADMIN, so a manager's page asks the
  // backend for exactly what it renders and nothing more. The rest of the page
  // is the same load for both roles, because both roles see the same four
  // operation groups (service charge, discount, PIN, credit).
  const loadSettings = useCallback(async () => {
    const [serviceCharge, discountOptions, discountAuthorization, creditConfig, admin] =
      await Promise.all([
        settingsApi.serviceCharge(),
        settingsApi.discountOptions(),
        settingsApi.discountAuthorization().catch(() => ({ configured: false })),
        settingsApi.credit(),
        loadsAdminSettings(user?.role)
          ? Promise.all([
              api.tables(),
              settingsApi
                .monthlySalesPeriod()
                .catch(() => ({ months: MONTHLY_SALES_PERIOD_MONTHS[1] })),
            ])
          : Promise.resolve(null),
      ])

    setServiceAmounts(serviceCharge.amounts.map((amount) => String(amount / 100)))
    setDiscountAmounts(discountOptions.amounts.map((amount) => String(amount / 100)))
    setDiscountPinConfigured(discountAuthorization.configured)
    setCredit(creditConfig)
    if (admin) {
      const [tables, monthlySalesPeriod] = admin
      setTableCount(tables.length)
      setSavedTableCount(tables.length)
      setMonthlyPeriod(monthlySalesPeriod.months)
      setSavedMonthlyPeriod(monthlySalesPeriod.months)
    }
  }, [user?.role])

  // The page is MANAGER+, and must be re-read whenever the resolved role
  // changes, so the form can never show one role what was loaded for another.
  // External async init on role resolution.
  useEffect(() => {
    if (!canOpenDevSettings(user?.role)) return

    // oxlint-disable-next-line react/set-state-in-effect -- role-driven read.
    void loadSettings().catch((error) => toast(errText(error), 'error'))
  }, [user?.role, loadSettings, toast, errText])

  // Nothing at all for STAFF: the page is not theirs to open, so it renders no
  // header, no controls and no empty shells. The backend refuses every command
  // behind it independently — this is presentation, not the boundary.
  if (!canOpenDevSettings(user?.role)) return null

  const see = (section: Parameters<typeof canSeeDevSection>[1]) =>
    canSeeDevSection(user?.role, section)
  const isAdmin = user?.role === 'ADMIN'

  async function saveSettings() {
    setBusy('settings')

    try {
      // Discount options are configuration, not a sale; the two lists are
      // validated by the same rule but refused with different codes, so a
      // manager can tell which one the backend rejected.
      const service = requireAmounts(serviceAmounts, 'settings.invalid_service_charge')
      const discount = requireAmounts(discountAmounts, 'settings.invalid_discount')

      await Promise.all([
        settingsApi.setServiceCharge({ amounts: service }),
        settingsApi.setDiscountOptions({ amounts: discount }),
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

  async function loadDemoData() {
    setBusy('demo')

    const reseedToken = developerApi.takeReseedToken()

    try {
      await developerApi.loadDemo(reseedToken)

      // The grant is single-use.
      if (reseedToken) {
        developerApi.clearReseedToken()
      }

      // The demo load performs its own reset, which destroyed the session that
      // called it — so the local session MUST be dropped or the UI would keep
      // rendering a page for an account that no longer exists.
      clearLocalSession()

      // Local UI state is stale now that everything was rebuilt.
      setServiceAmounts([])
      setDiscountAmounts([])
      setDiscountPinConfigured(false)
      setCredit({ enabled: false, mode: 'LIST', allowed_customer_ids: [] })
      setTableCount(0)
      setSavedTableCount(0)
      setMonthlyPeriod(MONTHLY_SALES_PERIOD_MONTHS[1])
      setSavedMonthlyPeriod(MONTHLY_SALES_PERIOD_MONTHS[1])
      setConfirmDemo(false)

      toast(t('dev.demoSuccess'), 'success')
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

            <p className="text-sm text-foreground-muted">{t('dev.serviceChargeHelp')}</p>

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
          <DevDiscountPinSettings
            configured={discountPinConfigured}
            onOpen={() => {
              setPinError(null)
              setPinDialogOpen(true)
            }}
          />

          {/* Credit settings */}
          <DevCreditSettings credit={credit} onCreditChange={setCredit} />
        </div>

        <Button className="mt-4" loading={busy === 'settings'} onClick={() => void saveSettings()}>
          {t('dev.save')}
        </Button>
      </Card>

      {/*
        Chart bar colours and global display formatting are PRESENTATION
        preferences, not cafe configuration, so they stay ADMIN-only: a manager's
        page must not be able to restyle every screen in the application.
      */}
      {isAdmin ? (
        <>
          {/* Chart bar colours — one card, one store, every chart in the app. */}
          <ChartColorsCard />
        </>
      ) : null}

      {/* Local Network Access — a MANAGER-visible section: the address their
          phone uses, the QR for it, and the switch that starts the service. */}
      {see('local-network-access') ? <LocalAccessCard /> : null}

      {/* Global display formatting */}
      {isAdmin ? <DisplayFormattingCard /> : null}

      {/* Tables — ADMIN-only. The number of cafe tables is a system
          configuration with no manager-facing meaning on this page. */}
      {isAdmin ? (
        <DevTableCountCard
          tableCount={tableCount}
          onTableCountChange={setTableCount}
          changed={tableCountChanged}
          busy={busy === 'tables'}
          onSave={() => void applyTableCount()}
        />
      ) : null}

      {/* Monthly sales chart window — ADMIN-only: a REPORTING window, not one of
          the manager's operational sections. */}
      {isAdmin ? (
        <DevMonthlySalesPeriodCard
          months={monthlyPeriod}
          onMonthsChange={setMonthlyPeriod}
          changed={monthlyPeriodChanged}
          busy={busy === 'period'}
          onSave={() => void applyMonthlyPeriod()}
        />
      ) : null}

      {/* Worked-duration display — a DISPLAY preference, grouped with the tables
          and the chart window rather than inside the money/date card, because it
          is read by the employees surface and has its own Save. ADMIN-only, like
          the rest of the presentation group. */}
      {isAdmin ? <DevWorkDurationCard /> : null}

      {/* Monthly revenue targets — the cafe/wash business configuration. A
          MANAGER-visible section: the cafe target, the wash target and the
          active month's override of either. They stay two separate targets —
          there is deliberately no combined overall figure. */}
      {see('monthly-targets') ? <RevenueTargetsCard /> : null}

      {/* Danger zone — ADMIN-only. These three actions clear or rebuild the
          whole database; the service authorizes each one as ADMIN regardless of
          what this page renders. */}
      {isAdmin ? (
        <DevDangerZone
          busy={busy}
          onLoadOfficial={() => void loadOfficialData()}
          onRequestDemo={() => setConfirmDemo(true)}
          onRequestClear={() => setConfirmClear(true)}
        />
      ) : null}

      {/* Application Updates — MANAGER-visible. Manual check, manual install,
          and the open-business-day / open-shift gate that refuses to close the
          app mid-sale are all unchanged; only who may REACH the section changed.
          It stays the LAST section of the page, after the Danger Zone: it is the
          newest, least frequent and least reversible-looking control here. */}
      {see('application-update') ? <ApplicationUpdatesCard /> : null}

      {/* Clear confirmation */}
      <Dialog
        open={confirmClear}
        onClose={() => closeWhenIdle(busy, 'clear', () => setConfirmClear(false))}
        title={t('dev.clearConfirmationTitle')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-6 text-foreground">{t('dev.clearWarning')}</p>

          <p className="text-xs leading-5 text-foreground-muted">{t('dev.clearNextStep')}</p>

          <DialogActions>
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
          </DialogActions>
        </div>
      </Dialog>

      {/* Demo load confirmation — its own dialog, so the two destructive
          actions can never be confirmed by accident through each other. */}
      <Dialog
        open={confirmDemo}
        onClose={() => closeWhenIdle(busy, 'demo', () => setConfirmDemo(false))}
        title={t('dev.demoWarningTitle')}
      >
        <div className="flex flex-col gap-4">
          <p className="whitespace-pre-line text-sm leading-6 text-foreground">
            {t('dev.demoWarning')}
          </p>

          {/* The credentials are shown here because the operation ENDS the
              session: without them the user would have no way back in. */}
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-input p-3">
            <p className="text-sm font-bold text-foreground-strong">
              {t('dev.demoCredentialsTitle')}
            </p>

            <p className="text-xs text-foreground-muted">{t('dev.demoCredentialsHint')}</p>

            <ul className="flex flex-col gap-1 text-xs text-foreground" dir="ltr">
              <li>{t('dev.demoCredentialsAdmin')}</li>
              <li>{t('dev.demoCredentialsManager')}</li>
              <li>{t('dev.demoCredentialsCashier')}</li>
            </ul>
          </div>

          <DialogActions>
            <Button
              variant="outline"
              disabled={busy === 'demo'}
              onClick={() => setConfirmDemo(false)}
            >
              {t('dev.dangerZoneCancelLabel')}
            </Button>

            <Button
              variant="destructive"
              loading={busy === 'demo'}
              disabled={busy !== null}
              onClick={() => void loadDemoData()}
            >
              <Sparkles size={16} aria-hidden />
              {t('dev.demoConfirmLabel')}
            </Button>
          </DialogActions>
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
