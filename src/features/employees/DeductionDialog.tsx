/**
 * تسجيل خصم — record a deduction against the employee whose drawer is open.
 *
 * A deduction is money withheld from a payslip, and this dialog says so in its own
 * description: it creates NO expense and moves no expense total, so a manager can
 * never leave this form believing the café spent something.
 *
 * The employee is NOT selectable here. The drawer already identifies the person,
 * and offering a second picker would only create a way to record a deduction
 * against the wrong one. The backend still receives and validates the id — a
 * hidden control is not a security boundary.
 *
 * Validation is immediate AND authoritative: the form refuses a missing, zero or
 * negative amount before sending, and the service refuses the same cases (plus a
 * nonexistent employee and a malformed date) regardless of what was rendered.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, DatePicker, Dialog, DialogActions, useToast } from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Save } from '@/components/ui/icon'
import { useErrText } from '@/lib/err'
import { todayIso } from '@/lib/date'
import { parseMajor } from '@/lib/utils'
import { employeesApi } from '@/services/employeesApi'

export function DeductionDialog({
  employeeId,
  employeeName,
  onClose,
  onSaved,
}: {
  readonly employeeId: number
  readonly employeeName: string
  readonly onClose: () => void
  /** Called after the backend accepted the record, so the page can refresh. */
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayIso())
  const [reason, setReason] = useState('')
  const [amountError, setAmountError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    const minor = parseMajor(amount)
    if (minor === null || minor <= 0) {
      setAmountError(t('errors.deduction.invalid_amount'))
      return
    }
    setAmountError(null)
    setBusy(true)
    try {
      await employeesApi.createDeduction(employeeId, {
        amount: minor,
        // The drawer knows which person this is; the date is the only other fact a
        // manager supplies, and it decides the month the deduction reduces.
        deduction_date: date || null,
        reason: reason.trim() || null,
      })
      toast(t('employees.deduction.saved'), 'success')
      onClose()
      onSaved()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={() => !busy && onClose()} title={t('employees.deduction.title')}>
      <div className="flex flex-col gap-4">
        <p className="text-caption text-foreground-subtle">
          {t('employees.deduction.body', { name: employeeName })}
        </p>

        <Field label={t('app.amount')} error={amountError}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              if (amountError) setAmountError(null)
            }}
            placeholder="0.00"
            autoFocus
          />
        </Field>

        <Field label={t('app.date')}>
          <DatePicker value={date} onChange={setDate} />
        </Field>

        <Field label={t('app.notes')} hint={t('employees.deduction.reasonHint')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>

        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('app.cancel')}
          </Button>
          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}
