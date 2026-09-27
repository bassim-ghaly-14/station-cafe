import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, useToast } from '@/components/ui'
import { Save } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { api } from '@/services/posApi'

export function NewCustomerForm({
  query,
  onClose,
  onCreated,
}: {
  readonly query: string
  readonly onClose: () => void
  readonly onCreated: (id: number) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [name, setName] = useState(query)
  const [phone, setPhone] = useState('')
  const [plate, setPlate] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Duplicate phone / plate is a BUSINESS rule enforced by the backend; the
  // message is surfaced here in Arabic so the cashier understands the refusal
  // instead of losing the typed data to a generic error.
  const fail = (e: unknown) => {
    const message = t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])

    setError(message)
    toast(message, 'error')
  }

  return (
    <div className="mt-3 rounded border border-border p-3">
      <h4 className="mb-2 font-bold">{t('pos.newCustomer')}</h4>
      <div className="flex flex-col gap-2">
        <Field label={t('pos.customerName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('pos.phone')}>
          <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={t('pos.plateOptional')}>
          <Input dir="ltr" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} />
        </Field>
        <Field label={t('pos.modelOptional')}>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy || !name.trim()}
            loading={busy}
            onClick={() => {
              setBusy(true)
              setError(null)
              api
                .createCustomer({ name: name.trim(), phone: phone.trim() || null })
                .then((id) => {
                  if (plate.trim()) {
                    return api
                      .createCar({
                        customer_id: id,
                        plate_no: plate.trim().toUpperCase(),
                        car_model: model.trim() || null,
                      })
                      .then(() => id)
                  }
                  return id
                })
                .then(onCreated)
                .catch(fail)
                .finally(() => setBusy(false))
            }}
          >
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
