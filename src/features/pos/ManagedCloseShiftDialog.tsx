/**
 * The managerial close of ANOTHER cashier's open shift — the operational
 * recovery path for a cashier who left without closing their till.
 *
 * Review and confirmation are deliberately TWO steps:
 *
 *   1. the SAME `CloseShiftDialog` the cashier's own flow uses, fed from the
 *      MANAGER-only `preview_managed_shift_close` command — so the manager
 *      reviews the identical backend-computed reconciliation document before
 *      anything is committed;
 *   2. an explicit `ConfirmDialog` naming the cashier and the shift, stating
 *      that the close is recorded on the manager's behalf and cannot be undone.
 *
 * Nothing here computes money: every figure comes from the backend preview,
 * and the submit sends only the counted drawer to the same close path the
 * cashier's flow shares. While a close is in flight the dialogs refuse to
 * dismiss and the confirm button is disabled, so a repeated click can never
 * produce a second closure.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog, useToast } from '@/components/ui'
import { parseMajor } from '@/lib/utils'
import { api } from '@/services/posApi'
import { opsApi, type Expense } from '@/services/opsApi'
import {
  shiftApi,
  type CashStatus,
  type ShiftClosingPreview,
  type ShiftRow,
} from '@/services/shiftApi'
import { CloseShiftDialog } from './CloseShiftDialog'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'

function errorText(t: ReturnType<typeof useTranslation>['t'], error: unknown) {
  return t([`errors.${(error as { message: string }).message}`, 'errors.internal_error'])
}

export function ManagedCloseShiftDialog({
  shift,
  onClose,
  onClosed,
}: Readonly<{
  readonly shift: ShiftRow
  /** The manager backed out. Ignored while a close is in flight. */
  readonly onClose: () => void
  /** The close COMMITTED server-side: dismiss and let the caller re-read state. */
  readonly onClosed: () => void | Promise<void>
}>) {
  const { t } = useTranslation()
  const toast = useToast()
  const [preview, setPreview] = useState<ShiftClosingPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actualCash, setActualCash] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [shiftExpenses, setShiftExpenses] = useState<Expense[] | null>(null)
  const [printPreview, setPrintPreview] = useState<PrintPreviewTarget | null>(null)
  const parsedCash = useMemo(() => parseMajor(actualCash), [actualCash])
  /**
   * The pending, un-submitted verdict against the backend's expected cash —
   * the same preview-only comparison the cashier's panel performs, so the two
   * dialogs always speak the same vocabulary.
   */
  const pendingStatus = useMemo<CashStatus | null>(() => {
    if (!preview || parsedCash === null) return null
    if (parsedCash === preview.expected_cash) return 'BALANCED'
    return parsedCash < preview.expected_cash ? 'SHORTAGE' : 'SURPLUS'
  }, [preview, parsedCash])

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true)
    try {
      setPreview(await shiftApi.previewManagedShiftClose(shift.id))
      setError(null)
    } catch (e) {
      setPreview(null)
      setError(errorText(t, e))
    } finally {
      setLoadingPreview(false)
    }
  }, [shift.id, t])

  // The closing preview is read when the dialog opens — the manager never
  // commits a close against figures that are not on screen.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    void loadPreview()
  }, [loadPreview])

  // The shift's expense rows, from the same backend list the cashier's dialog
  // shows. A failed read degrades to an empty list, exactly like the cashier's
  // panel: the reconciliation document still carries the expense totals.
  const loadExpenses = useCallback(async () => {
    try {
      setShiftExpenses(await opsApi.expensesOfShift(shift.id))
    } catch {
      setShiftExpenses([])
    }
  }, [shift.id])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    void loadExpenses()
  }, [loadExpenses])

  // The dialog is not dismissible while a close is in flight: the command is
  // already committed server-side, so leaving it open would invite a second one.
  function closeDialog() {
    if (busy) return
    onClose()
  }

  // Typing replaces the previous verdict, so any stale submission error is
  // cleared by the same action that changes what it was about.
  function changeActualCash(value: string) {
    setActualCash(value)
    if (error) setError(null)
  }

  /** Step 1 of the flow: ask for the explicit managerial confirmation. */
  function requestConfirm() {
    if (busy || parsedCash === null || !preview) return
    setConfirming(true)
  }

  /** Step 2: the confirmed managerial close, through the shared backend path. */
  async function submit() {
    if (busy || parsedCash === null || !preview) {
      setConfirming(false)
      return
    }
    setBusy(true)
    setError(null)
    let result: Awaited<ReturnType<typeof shiftApi.closeManagedShift>>
    try {
      result = await shiftApi.closeManagedShift(shift.id, parsedCash)
    } catch (e) {
      setError(errorText(t, e))
      setConfirming(false)
      setBusy(false)
      return
    }
    setConfirming(false)
    toast(t('shift.managerCloseSuccess', { name: shift.user_name ?? '' }), 'success')
    // The closing document is the same one the cashier's flow prints; a print
    // failure never reports the financial close as failed.
    try {
      await api.printShift(result.shift.id)
    } catch (e) {
      toast(
        (e as { message: string }).message.startsWith('printer.')
          ? t('shift.closedPrintWarning')
          : t('print.failed'),
        'error',
      )
    }
    onClose()
    try {
      await onClosed()
    } catch {
      // The financial close is committed; a refresh failure must not report it as failed.
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <CloseShiftDialog
        preview={preview}
        loadingPreview={loadingPreview}
        error={error}
        busy={busy}
        actualCash={actualCash}
        parsedCash={parsedCash}
        pendingStatus={pendingStatus}
        shiftExpenses={shiftExpenses}
        onActualCashChange={changeActualCash}
        onFillExpected={() => {
          if (!preview) return
          setActualCash((preview.expected_cash / 100).toFixed(2))
          if (error) setError(null)
        }}
        onRetry={() => void loadPreview()}
        onPrintPreview={() => setPrintPreview({ kind: 'shift_report', shift_id: shift.id })}
        onConfirm={requestConfirm}
        onCancel={closeDialog}
      />
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          if (!busy) setConfirming(false)
        }}
        onConfirm={() => void submit()}
        title={t('shift.managerCloseConfirmTitle')}
        body={t('shift.managerCloseConfirmBody')}
        detail={t('shift.managerCloseConfirmDetail', {
          id: shift.id,
          name: shift.user_name ?? t('pos.unknownCashier'),
        })}
        confirmLabel={t('shift.managerCloseConfirmAction')}
        cancelLabel={t('app.cancel')}
        destructive
        busy={busy}
      />
      {printPreview ? (
        <PrintPreviewDialog target={printPreview} onClose={() => setPrintPreview(null)} />
      ) : null}
    </>
  )
}
