/**
 * Customer / vehicle picker for orders.
 *
 * Registered customers are shown IMMEDIATELY — searching is an accelerator,
 * never a precondition. Search filters name / phone / plate as the user types,
 * and "بدون عميل" is a first-class, intentional choice rather than missing
 * data: it is exactly what the invoice will be recorded as.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, useToast } from '@/components/ui'
import { Car, Plus, UserX } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { api, type CustomerWithCars, type PosOrder } from '@/services/posApi'
import { NewCustomerForm } from './NewCustomerForm'

export function CustomerPicker({
  orderId,
  onClose,
  onAttached,
}: {
  readonly orderId: number
  readonly onClose: () => void
  readonly onAttached: (o: PosOrder) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [all, setAll] = useState<CustomerWithCars[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [newOpen, setNewOpen] = useState(false)

  // Stable identity, so the load-once effect below can depend on it honestly
  // instead of closing over a fresh closure every render.
  const report = useCallback(
    (e: unknown) =>
      toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error'),
    [t, toast],
  )

  // The full registered list is loaded once when the picker opens, so browsing
  // is instant and typing never waits for a round trip.
  useEffect(() => {
    let active = true
    api.customers('').then((rows) => {
      if (active) setAll(rows)
    }, report)
    // Loaded once per opening: this dialog remounts on every open.
    return () => {
      active = false
    }
  }, [report])

  const searching = query.trim().length > 0
  const results = useMemo(() => {
    if (!all) return []
    const term = query.trim().toLowerCase()
    if (!term) return all
    return all.filter((c) => {
      const haystack = [c.name, c.phone ?? '', ...c.cars.map((car) => car.plate_no)]
        .join(' ')
        .toLowerCase()
      return haystack.includes(term)
    })
  }, [all, query])

  const attach = (customerId: number | null, plate: string | null = null) => {
    setBusy(true)
    const done = () => api.getOrder(orderId).then(onAttached)
    const request =
      customerId === null
        ? api.detachCustomer(orderId).then(done)
        : api
            .attachCustomer({ order_id: orderId, customer_id: customerId, car_plate: plate })
            .then(done)

    request.catch(report).finally(() => setBusy(false))
  }

  return (
    <Dialog open onClose={onClose} title={t('pos.customerCar')} wide>
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('pos.customerSearchHint')}
              aria-label={t('pos.customerSearch')}
            />
          </div>

          <Button variant="outline" onClick={() => setNewOpen(true)}>
            <Plus size={16} aria-hidden />
            {t('pos.newCustomer')}
          </Button>
        </div>

        {/* An explicit, intentional choice — not a fallback for missing data. */}
        <button
          type="button"
          onClick={() => attach(null)}
          disabled={busy}
          className="flex min-h-12 items-center gap-2 rounded-md border border-border-strong px-3 text-start text-sm transition-colors hover:border-border-accent-hover hover:bg-surface-hover disabled:opacity-60"
        >
          <UserX size={18} aria-hidden className="shrink-0 text-foreground-muted" />

          <span className="min-w-0">
            <span className="block font-bold text-foreground-strong">{t('pos.noCustomer')}</span>

            <span className="block text-xs text-foreground-subtle">
              {t('pos.noCustomerChosen')}
            </span>
          </span>
        </button>
      </div>

      <CustomerResults
        loaded={all !== null}
        results={results}
        searching={searching}
        busy={busy}
        onAttach={attach}
      />

      {newOpen ? (
        <NewCustomerForm
          query={query}
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false)
            // Refresh the browsable list so the new customer is selectable at
            // once, then attach it to this order.
            void api.customers(query.trim()).then(setAll).catch(report)
            attach(id)
          }}
        />
      ) : null}
    </Dialog>
  )
}

/**
 * The browsable customer list in its three states: still loading, nothing to
 * show, or the results.
 *
 * The heading distinguishes a search from browsing the registered list, so the
 * user is never left wondering whether the list they see is everything or just
 * what matched.
 */
function CustomerResults({
  loaded,
  results,
  searching,
  busy,
  onAttach,
}: Readonly<{
  /** The registered list has resolved; before that there is nothing to show. */
  loaded: boolean
  results: CustomerWithCars[]
  searching: boolean
  busy: boolean
  onAttach: (customerId: number, plate: string | null) => void
}>) {
  const { t } = useTranslation()
  if (!loaded) {
    return <p className="py-6 text-center text-sm text-foreground-subtle">{t('app.loading')}</p>
  }
  if (results.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm font-bold text-foreground-strong">{t('pos.noCustomers')}</p>

        <p className="mt-1 text-xs text-foreground-subtle">{t('pos.noCustomersHint')}</p>
      </div>
    )
  }
  return (
    <>
      <p className="mb-2 text-xs font-medium text-foreground-subtle">
        {searching ? t('pos.customerSearchResults') : t('pos.customerRegistered')}
      </p>

      {/*
       * The results list.
       *
       * `sm:`-only height cap and scroll, for the same reason as the POS product
       * grid: this list lives inside a `Dialog`, and the dialog is ALREADY the
       * scroll container on a phone. An independently scrolling list inside it
       * is a nested scroller — dragging the results scrolls a small inner box
       * while the dialog stays put, so a long result set becomes very hard to
       * reach the bottom of. On desktop, where the dialog is a fixed-height
       * card that must not grow without limit, the cap earns its keep.
       */}
      <ul className="grid grid-cols-1 gap-2 sm:max-h-80 sm:grid-cols-2 sm:overflow-y-auto">
        {results.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onAttach(c.id, null)}
              disabled={busy}
              className="flex min-h-16 w-full flex-col justify-center gap-1 rounded-md border border-border-strong p-2 text-start transition-colors hover:border-border-accent-hover hover:bg-surface-hover disabled:opacity-60"
            >
              <span className="w-full truncate text-sm font-bold text-foreground-strong">
                {c.name}
              </span>

              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-subtle">
                {c.phone ? (
                  <span dir="ltr" className="tabular-nums">
                    {c.phone}
                  </span>
                ) : null}

                {c.cars.map((car) => (
                  <span
                    key={car.id}
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
                  >
                    <Car size={12} aria-hidden />

                    <span dir="ltr">{car.plate_no}</span>

                    {car.car_model ? (
                      <span className="text-foreground-subtle">{car.car_model}</span>
                    ) : null}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
