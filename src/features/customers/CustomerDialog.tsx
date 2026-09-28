/**
 * Add / edit customer dialog.
 *
 * Create is open to every authenticated role (the POS already creates
 * customers at the table); EDIT is manager-only in the existing authorization
 * model, so the edit path is only ever mounted for a role the backend accepts.
 *
 * A vehicle can be registered together with a new customer, because that is
 * how a car-wash customer actually arrives — but only on create: renaming an
 * existing customer must never silently mutate its vehicles.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogActions } from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { customersApi } from '@/services/customersApi'
import type { CustomerRow } from '@/services/customersApi'

export type CustomerDialogMode = { kind: 'create' } | { kind: 'edit'; customer: CustomerRow }

export function CustomerDialog({
  mode,
  onClose,
  onSaved,
}: {
  readonly mode: CustomerDialogMode | null
  readonly onClose: () => void
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [plate, setPlate] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  // Re-seed the form for each opening, so a previous entry never leaks in.
  useEffect(() => {
    if (!mode) return
    const customer = mode.kind === 'edit' ? mode.customer : null
    setName(customer?.name ?? '')
    setPhone(customer?.phone ?? '')
    setNotes(customer?.notes ?? '')
    setPlate('')
    setModel('')
    setError(null)
    setNameError(null)
  }, [mode])

  if (!mode) return null
  const editing = mode.kind === 'edit'

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError(t('errors.customers.name_required'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode?.kind === 'edit') {
        await customersApi.update(mode.customer.id, {
          name: trimmed,
          phone: phone.trim() || null,
          notes: notes.trim() || null,
        })
        toast(t('customers.form.updated'), 'success')
      } else {
        const id = await customersApi.create({
          name: trimmed,
          phone: phone.trim() || null,
          notes: notes.trim() || null,
        })
        if (plate.trim()) {
          await customersApi.createCar({
            customer_id: id,
            plate_no: plate.trim().toUpperCase(),
            car_model: model.trim() || null,
          })
        }
        toast(t('customers.form.created'), 'success')
      }
      onSaved()
      onClose()
    } catch (cause) {
      // Duplicate phone/plate is a BUSINESS rule enforced by the backend; the
      // Arabic message keeps the typed data on screen instead of losing it.
      const message = t([
        `errors.${(cause as { message: string }).message}`,
        'errors.internal_error',
      ])
      setError(message)
      toast(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? t('customers.form.editTitle') : t('customers.form.createTitle')}
    >
      <div className="flex flex-col gap-4">
        <Field
          label={t('customers.form.name')}
          error={nameError ?? undefined}
          htmlFor="customer-name"
        >
          <Input
            id="customer-name"
            value={name}
            data-dialog-autofocus
            onChange={(e) => {
              setName(e.target.value)
              setNameError(null)
            }}
          />
        </Field>

        <Field label={t('customers.form.phone')} htmlFor="customer-phone">
          <Input
            id="customer-phone"
            dir="ltr"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>

        <Field label={t('app.notes')} htmlFor="customer-notes">
          <Textarea id="customer-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {/* A new customer may arrive with their vehicle; an existing record's
            vehicles are managed from the customer itself, not from here. */}
        {!editing ? (
          <>
            <Field label={t('customers.form.plate')} htmlFor="customer-plate">
              <Input
                id="customer-plate"
                dir="ltr"
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label={t('customers.form.model')} htmlFor="customer-model">
              <Input id="customer-model" value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {busy ? t('app.loading') : t('app.save')}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}
