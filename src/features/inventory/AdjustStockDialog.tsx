/**
 * المخزون — the stock adjustment dialog.
 *
 * This is the page's ONE operation and it is extracted verbatim in behaviour.
 * Every rule below is the rule the inline dialog already enforced, and none of
 * it moved:
 *
 *  - the change is parsed with `Number.parseInt`, and anything that is not an
 *    integer — or is exactly zero — is refused with `errors.inventory.zero_change`
 *    BEFORE any request is made. A zero change is what the backend would reject
 *    too; refusing it here saves a round trip and keeps the message next to the
 *    field that caused it;
 *  - the reason is one of the fixed `STOCK_REASONS`, defaulting to `PURCHASE`.
 *    That constant mirrors a backend-enforced vocabulary, so this dialog cannot
 *    offer a value the service would refuse;
 *  - the note is trimmed, and an empty note is sent as `null` rather than as an
 *    empty string;
 *  - the reason control is now the SHARED `Select`, replacing the raw `<select>`
 *    and its hand-copied class string. That is a styling alignment only: the
 *    element, its options, its value and its change handler are the same native
 *    control, so the keyboard and screen-reader behaviour is unchanged — and the
 *    chevron it gains sits on the inline-end edge, which is what makes the
 *    control read correctly in RTL;
 *  - the button shows the busy state through the shared `Button` `loading` prop,
 *    which blocks a second submit while the transaction is in flight.
 *
 * Everything the backend validates — that the product exists, that it tracks
 * inventory, that the reason is one of the three — is surfaced by the existing
 * toast through `useErrText`. This dialog never second-guesses the service.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogActions, Select } from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import { STOCK_REASONS, opsApi, type StockRow } from '@/services/opsApi'

/**
 * Fixed ids for the three controls.
 *
 * `Field`'s own generated id only reaches its control when the field has exactly
 * one element child; these fields have two each (the control and a hint), so the
 * association is declared here instead. They are module constants rather than
 * `useId` values because the dialog renders at most one instance at a time.
 */
const CHANGE_ID = 'inventory-adjust-change'
const REASON_ID = 'inventory-adjust-reason'
const NOTE_ID = 'inventory-adjust-note'

export function AdjustStockDialog({
  item,
  onClose,
  onDone,
}: Readonly<{
  readonly item: StockRow
  readonly onClose: () => void
  readonly onDone: () => void
}>) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [change, setChange] = useState('')
  const [reason, setReason] = useState<(typeof STOCK_REASONS)[number]>('PURCHASE')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const n = Number.parseInt(change.trim(), 10)
    if (!Number.isInteger(n) || n === 0) {
      toast(t('errors.inventory.zero_change'), 'error')
      return
    }
    setBusy(true)
    try {
      await opsApi.adjustStock(item.product_id, n, reason, note.trim() || null)
      onDone()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('inventory.adjustTitle', { name: item.product_name })}>
      <div className="flex flex-col gap-4">
        {/*
          Each field names its control EXPLICITLY with `htmlFor` + `id`.

          This is not decoration. `Field` can only auto-associate a label when it
          has exactly ONE element child, and both of these fields have two (the
          control plus a hint). With two children the label falls back to a
          generated id that no control ever receives, so the visible Arabic label
          is read as unassociated text and clicking it does not focus the field.
          Naming the pair here fixes it inside this dialog, without changing the
          shared component every other form in the app already depends on.
        */}
        <Field label={t('inventory.change')} htmlFor={CHANGE_ID}>
          <Input
            id={CHANGE_ID}
            dir="ltr"
            inputMode="numeric"
            value={change}
            onChange={(e) => setChange(e.target.value)}
          />
          <p className="text-caption">{t('inventory.changeHint')}</p>
        </Field>
        <Field label={t('inventory.reason')} htmlFor={REASON_ID}>
          <Select
            id={REASON_ID}
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
          >
            {STOCK_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`inventory.reason.${r}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('app.notes')} htmlFor={NOTE_ID}>
          <Textarea id={NOTE_ID} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
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
