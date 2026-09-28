/**
 * The close-shift dialog: the reconciliation the user performs against the
 * closing figures.
 *
 * It is presentational. The panel above owns the preview request, the amount the
 * user typed, the verdict derived from it and the submission — this component
 * only lays those out and forwards the intents, so the dialog can never hold a
 * second copy of the closing state.
 *
 * The form is rendered from the first commit, so the cash field exists — and
 * holds initial focus — before the closing figures arrive. Only the
 * SERVER-DERIVED values show a loading state; the input never does, and the user
 * is never asked to open a dialog to refresh anything.
 */
import { useTranslation } from 'react-i18next'
import {
  AmountAutoFill,
  Button,
  Dialog,
  EmployeeAvatar,
  ListRowsSkeleton,
  MoneyDisplay,
  Skeleton,
} from '@/components/ui'
import { DisplayDateTime } from '@/components/ui/display-datetime'
import { Eye, Lock } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { ErrorState } from '@/components/states'
import { cn } from '@/lib/utils'
import { formatMinorMoney } from '@/lib/money'
import type { CashStatus, ShiftClosingPreview } from '@/services/shiftApi'
import type { Expense } from '@/services/opsApi'
import { ShiftExpenseList } from './ShiftExpenses'
import {
  ExpensesSection,
  ExpectedCashSection,
  SalesSection,
  ServicesSection,
} from './ReconciliationSections'
import { statusLabelKey, statusTone } from './reconciliationStatus'

/** Who opened the shift and the window it covers, from the closing preview. */
function CloseShiftMeta({ preview }: Readonly<{ preview: ShiftClosingPreview | null }>) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-3 rounded-md bg-surface-muted p-3 sm:grid-cols-3">
      <div>
        <p className="text-caption">{t('shift.cashier')}</p>
        {preview ? (
          <p className="flex min-w-0 items-center gap-1.5 font-bold">
            <EmployeeAvatar role={preview.shift.user_role} size="sm" />
            <span className="truncate">{preview.shift.user_name ?? '—'}</span>
          </p>
        ) : (
          <Skeleton variant="text" className="h-5 w-24" accessibilityLabel="" />
        )}
      </div>
      <div className="min-w-0">
        <p className="text-caption">{t('shift.from')}</p>
        {preview ? (
          <p className="min-w-0 font-bold">
            <DisplayDateTime value={preview.shift.opened_at} />
          </p>
        ) : (
          <Skeleton variant="text" className="h-5 w-28" accessibilityLabel="" />
        )}
      </div>
      <div className="min-w-0">
        <p className="text-caption">{t('shift.to')}</p>
        {preview ? (
          <p className="min-w-0 font-bold">
            <DisplayDateTime value={preview.closing_at} />
          </p>
        ) : (
          <Skeleton variant="text" className="h-5 w-28" accessibilityLabel="" />
        )}
      </div>
    </div>
  )
}

/**
 * The reconciliation document, or its placeholder.
 *
 * This is the SAME reconciliation document the printer will produce, rendered
 * from the backend report. No figure here is computed by this component.
 */
function ReconciliationDocument({ preview }: Readonly<{ preview: ShiftClosingPreview | null }>) {
  const { t } = useTranslation()
  if (!preview) {
    return (
      <output aria-label={t('app.loading')} className="block">
        <ListRowsSkeleton rows={6} />
      </output>
    )
  }
  return (
    <div className="space-y-3">
      <SalesSection data={preview.report} />
      <ServicesSection
        serviceCharges={preview.report.service_charges}
        discounts={preview.report.discounts}
      />
      <ExpensesSection
        total={preview.report.expenses}
        cashExpenses={preview.report.cash_expenses}
        breakdown={preview.report.expense_breakdown}
      />
      {/* Before a handover is entered there is nothing to compare, so only the
          expected figures are shown. */}
      <ExpectedCashSection cash={preview.report.cash} />
    </div>
  )
}

/**
 * The counted handover and the LIVE verdict it produces.
 *
 * The verdict is a live preview of what the user is about to create, not a
 * financial rule: `expected_cash` is the backend's figure and only the pending,
 * un-submitted input is compared against it. The submitted difference and status
 * always come back from the backend, so this label can never contradict the
 * persisted result. It reuses the same status vocabulary and colors as the
 * closing document so the two always agree.
 */
function ActualCashSection({
  preview,
  actualCash,
  parsedCash,
  pendingStatus,
  busy,
  onChange,
  onFill,
}: Readonly<{
  preview: ShiftClosingPreview | null
  actualCash: string
  parsedCash: number | null
  pendingStatus: CashStatus | null
  busy: boolean
  onChange: (value: string) => void
  onFill: () => void
}>) {
  const { t } = useTranslation()
  const difference = parsedCash === null ? 0 : Math.abs(parsedCash - (preview?.expected_cash ?? 0))
  return (
    <section>
      <Field
        label={t('shift.actualCash')}
        // Field-level feedback is validation only. A failed LOAD is reported once,
        // by the alert below, so the same problem is never announced twice.
        error={actualCash.trim() && parsedCash === null ? t('shift.invalidCash') : null}
        htmlFor="actual-cash"
      >
        <Input
          id="actual-cash"
          className="h-12 text-lg font-bold"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          // Declares THIS control as the dialog's initial focus target. The dialog
          // primitive honours the marker once per opening; the field then behaves
          // like any other controlled input for the rest of its life — no refocus,
          // no timer, no remount.
          data-dialog-autofocus=""
          value={actualCash}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          disabled={busy}
        />
      </Field>
      {/* The expected cash is a safe, backend-computed amount, so the
          balanced-drawer case needs no typing. Same shared auto-fill affordance as
          the payment dialog — an ACTION that writes the field, never a second
          amount reading. */}
      {preview ? (
        <AmountAutoFill
          className="mt-2"
          amount={preview.expected_cash}
          label={t('shift.autoFillLabel', { amount: formatMinorMoney(preview.expected_cash) })}
          hint={t('shift.autoFillHint')}
          active={parsedCash === preview.expected_cash}
          disabled={busy}
          onFill={onFill}
        />
      ) : null}
      {pendingStatus !== null ? (
        <div
          className={cn(
            'mt-3 flex items-center justify-between gap-3 rounded-md border p-3',
            statusTone(pendingStatus),
          )}
        >
          <span className="font-bold">{t(statusLabelKey(pendingStatus))}</span>
          <MoneyDisplay amount={difference} className="font-bold" />
        </div>
      ) : null}
      <p className="mt-3 text-caption">{t('shift.countHint')}</p>
    </section>
  )
}

/**
 * The dialog's footer: cancel, print the document first, and the close itself.
 *
 * Confirming is refused while the figures are still being read or while the
 * counted amount cannot be parsed, so a handover is never submitted against
 * numbers the backend has not returned.
 */
function CloseShiftActions({
  busy,
  loadingPreview,
  canConfirm,
  onCancel,
  onPrintPreview,
  onConfirm,
}: Readonly<{
  busy: boolean
  loadingPreview: boolean
  canConfirm: boolean
  onCancel: () => void
  onPrintPreview: () => void
  onConfirm: () => void
}>) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-4">
      <Button variant="outline" disabled={busy} onClick={onCancel}>
        {t('app.cancel')}
      </Button>
      <Button variant="ghost" disabled={busy || loadingPreview} onClick={onPrintPreview}>
        <Eye size={16} aria-hidden />
        {t('pos.printPreviewBeforePrint')}
      </Button>
      <Button
        variant="outline"
        className="border-closing-shift-border text-closing-shift-foreground hover:bg-closing-shift-soft"
        disabled={!canConfirm}
        loading={busy}
        onClick={onConfirm}
      >
        {!busy ? <Lock size={16} aria-hidden /> : null}
        {t('shift.confirmClose')}
      </Button>
    </div>
  )
}

export function CloseShiftDialog({
  preview,
  loadingPreview,
  error,
  busy,
  actualCash,
  parsedCash,
  pendingStatus,
  shiftExpenses,
  onActualCashChange,
  onFillExpected,
  onRetry,
  onPrintPreview,
  onConfirm,
  onCancel,
}: Readonly<{
  preview: ShiftClosingPreview | null
  loadingPreview: boolean
  error: string | null
  busy: boolean
  actualCash: string
  parsedCash: number | null
  pendingStatus: CashStatus | null
  shiftExpenses: Expense[] | null
  onActualCashChange: (value: string) => void
  onFillExpected: () => void
  onRetry: () => void
  onPrintPreview: () => void
  onConfirm: () => void
  onCancel: () => void
}>) {
  const { t } = useTranslation()
  return (
    <Dialog open onClose={onCancel} title={t('shift.closeTitle')} wide>
      {/* `dvh`, not `vh` — see the note in `DayClosingPanel`. */}
      <div className="max-h-[65dvh] space-y-4 overflow-y-auto">
        <CloseShiftMeta preview={preview} />

        <ReconciliationDocument preview={preview} />

        <div className="grid gap-4 sm:grid-cols-2">
          <section className="rounded-md border border-border-subtle p-3">
            <h3 className="mb-1 font-bold text-foreground-strong">{t('shift.shiftExpenses')}</h3>
            <ShiftExpenseList rows={shiftExpenses} />
          </section>
          <ActualCashSection
            preview={preview}
            actualCash={actualCash}
            parsedCash={parsedCash}
            pendingStatus={pendingStatus}
            busy={busy}
            onChange={onActualCashChange}
            onFill={onFillExpected}
          />
        </div>

        {/* A failed load is reported once, with a retry, because the figures the
            user must reconcile against do not exist yet. A failed SUBMISSION is
            reported inline — the dialog stays open with the amount intact. */}
        {error && !preview ? (
          <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
        ) : null}
        {error && preview ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <CloseShiftActions
          busy={busy}
          loadingPreview={loadingPreview}
          canConfirm={!busy && !loadingPreview && preview !== null && parsedCash !== null}
          onCancel={onCancel}
          onPrintPreview={onPrintPreview}
          onConfirm={onConfirm}
        />
      </div>
    </Dialog>
  )
}
