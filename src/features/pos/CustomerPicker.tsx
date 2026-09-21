/** Customer/car picker for orders (required for wash; optional for cafe). */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from '@/components/ui'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui'
import { api, type CustomerWithCars, type PosOrder } from '@/services/posApi'
import { NewCustomerForm } from './NewCustomerForm'

export function CustomerPicker({
  orderId,
  onClose,
  onAttached,
}: {
  orderId: number
  onClose: () => void
  onAttached: (o: PosOrder) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CustomerWithCars[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [newOpen, setNewOpen] = useState(false)

  const search = () => {
    if (!query.trim()) return
    setBusy(true)
    api
      .customers(query.trim())
      .then(setResults)
      .catch((e) =>
        toast(
          t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
          'error',
        ),
      )
      .finally(() => setBusy(false))
  }

  const attach = (customerId: number, plate: string | null) => {
    setBusy(true)
    api
      .attachCustomer({ order_id: orderId, customer_id: customerId, car_plate: plate })
      .then(() => api.getOrder(orderId))
      .then(onAttached)
      .catch((e) =>
        toast(
          t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
          'error',
        ),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onClose={onClose} title={t('pos.customerCar')} wide>
      <div className="mb-3 flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search()
          }}
          placeholder={t('pos.customerSearchHint')}
          aria-label={t('pos.customerSearch')}
        />
        <Button onClick={search} disabled={busy}>
          {t('app.search')}
        </Button>
        <Button variant="outline" onClick={() => setNewOpen(true)}>
          {t('pos.newCustomer')}
        </Button>
      </div>

      {results === null ? (
        <p className="py-3 text-center text-sm text-brand-500">{t('pos.customerSearchHint')}</p>
      ) : results.length === 0 ? (
        <p className="py-3 text-center text-sm text-brand-500">{t('pos.noCustomers')}</p>
      ) : (
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {results.map((c) => (
            <li key={c.id} className="rounded border border-brand-200 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{c.name}</span>
                <span dir="ltr" className="text-xs text-brand-500">
                  {c.phone ?? ''}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => attach(c.id, null)}
                  disabled={busy}
                >
                  {t('pos.attachOnly')}
                </Button>
                {c.cars.map((car) => (
                  <Button
                    key={car.id}
                    size="sm"
                    variant="outline"
                    onClick={() => attach(c.id, car.plate_no)}
                    disabled={busy}
                  >
                    <span dir="ltr">{car.plate_no}</span>
                    {car.car_model ? ` · ${car.car_model}` : ''}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {newOpen ? (
        <NewCustomerForm
          query={query}
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false)
            void api.customers(query.trim()).then(setResults)
            attach(id, null)
          }}
        />
      ) : null}
    </Dialog>
  )
}
