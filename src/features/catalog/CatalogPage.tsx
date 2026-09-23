/**
 * Manager catalog UI — products & services listing, search, filters,
 * create / edit / price / activation. Backend stays authoritative.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Badge, Button, Card, Dialog, MoneyDisplay } from '@/components/ui'
import { Field, Input } from '@/components/ui/input'
import { Check, Package, Pencil, Plus, Power, Save, Search } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { formatMinor, parseMajor } from '@/lib/utils'
import { useErrText } from '@/lib/err'
import { catalogApi, type NewProductInput } from '@/services/catalogApi'
import type { Product } from '@/services/posApi'

const DEPARTMENTS = ['CAFE', 'WASH'] as const
const TYPES = ['PRODUCT', 'SERVICE'] as const

export default function CatalogPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [items, setItems] = useState<Product[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [dept, setDept] = useState<'' | (typeof DEPARTMENTS)[number]>('')
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'INACTIVE'>('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [confirming, setConfirming] = useState<Product | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    catalogApi
      .list()
      .then(setItems)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
  }, [toast, errText])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    return (items ?? []).filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false
      if (dept && p.department !== dept) return false
      if (status === 'ACTIVE' && !p.is_active) return false
      if (status === 'INACTIVE' && p.is_active) return false
      return true
    })
  }, [items, query, dept, status])

  async function toggleActive(p: Product) {
    try {
      await catalogApi.setActive(p.id, !p.is_active)
      toast(p.is_active ? t('catalog.deactivated') : t('catalog.activated'), 'success')
      setConfirming(null)
      load()
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-heading flex items-center gap-2">
          <Package size={22} aria-hidden />
          {t('nav.catalog')}
        </h1>

        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} aria-hidden />
          {t('catalog.add')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute top-1/2 inset-s-3 -translate-y-1/2 text-foreground-faint"
          />

          <Input
            aria-label={t('catalog.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('catalog.search')}
            className="ps-9"
          />
        </div>

        <select
          aria-label={t('catalog.department')}
          value={dept}
          onChange={(e) => setDept(e.target.value as typeof dept)}
          className="h-10 rounded-md border border-border-strong bg-surface px-3 text-base"
        >
          <option value="">{t('catalog.allDepartments')}</option>

          {DEPARTMENTS.map((d) => (
            <option key={d} value={d}>
              {t(`catalog.${d}`)}
            </option>
          ))}
        </select>

        <select
          aria-label={t('app.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="h-10 rounded-md border border-border-strong bg-surface px-3 text-base"
        >
          <option value="">{t('catalog.allStatuses')}</option>
          <option value="ACTIVE">{t('catalog.active')}</option>
          <option value="INACTIVE">{t('catalog.inactive')}</option>
        </select>
      </div>

      {items === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <LoadingState label={t('app.loading')} />
        )
      ) : filtered.length === 0 ? (
        <EmptyState title={t('catalog.empty')} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {filtered.map((p) => (
            <Card key={p.id} className="flex min-h-48 flex-col gap-4 p-4">
              <div className="min-w-0">
                <p className="text-body truncate font-bold">{p.name}</p>

                <p className="text-caption mt-1">
                  {t(`catalog.${p.item_type}`)} · {t(`catalog.${p.department}`)}
                  {p.track_inventory ? ` · ${t('inventory.tracked')}` : ''}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <MoneyDisplay amount={p.price_minor} className="text-money" />

                <Badge tone={p.is_active ? 'success' : 'neutral'}>
                  {p.is_active ? t('catalog.active') : t('catalog.inactive')}
                </Badge>
              </div>

              <div className="mt-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setEditing(p)}
                >
                  <Pencil size={16} aria-hidden />
                  {t('catalog.edit')}
                </Button>

                <Button
                  variant={p.is_active ? 'destructiveGhost' : 'secondary'}
                  size="sm"
                  className="flex-1"
                  onClick={() => setConfirming(p)}
                >
                  <Power size={16} aria-hidden />
                  {p.is_active ? t('catalog.deactivate') : t('catalog.activate')}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {createOpen ? (
        <CreateProductDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => {
            setCreateOpen(false)
            toast(t('catalog.created', { name }), 'success')
            load()
          }}
        />
      ) : null}

      {editing ? (
        <EditProductDialog
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            toast(t('staff.saved'), 'success')
            load()
          }}
        />
      ) : null}

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t('catalog.confirmToggle')}
      >
        <p className="text-body mb-4">
          {t('catalog.confirmToggleBody', {
            name: confirming?.name ?? '',
            next: confirming?.is_active ? t('catalog.inactive') : t('catalog.active'),
          })}
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirming(null)}>
            {t('app.cancel')}
          </Button>

          <Button
            variant={confirming?.is_active ? 'destructive' : 'default'}
            onClick={() => confirming && toggleActive(confirming)}
          >
            <Check size={16} aria-hidden />
            {t('app.confirm')}
          </Button>
        </div>
      </Dialog>
    </div>
  )
}

function CreateProductDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [name, setName] = useState('')
  const [type, setType] = useState<(typeof TYPES)[number]>('PRODUCT')
  const [department, setDepartment] = useState<(typeof DEPARTMENTS)[number]>('CAFE')
  const [price, setPrice] = useState('')
  const [tracked, setTracked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)

  async function save() {
    const minor = parseMajor(price)

    if (!name.trim()) return

    if (minor === null) {
      setPriceError(t('catalog.invalidPrice'))
      return
    }

    setBusy(true)

    try {
      const input: NewProductInput = {
        name: name.trim(),
        item_type: type,
        department,
        price_minor: minor,
        track_inventory: tracked,
      }

      await catalogApi.create(input)
      onCreated(input.name)
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog.add')}>
      <div className="flex flex-col gap-4">
        <Field label={t('catalog.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('catalog.type')}>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-base"
            >
              {TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(`catalog.${v}`)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('catalog.department')}>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value as typeof department)}
              className="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-base"
            >
              {DEPARTMENTS.map((v) => (
                <option key={v} value={v}>
                  {t(`catalog.${v}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label={t('catalog.price')} error={priceError}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <label className="text-body flex items-center gap-2">
          <input
            type="checkbox"
            checked={tracked}
            onChange={(e) => setTracked(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          {t('inventory.trackItem')}
        </label>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>

          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function EditProductDialog({
  product,
  onClose,
  onSaved,
}: {
  product: Product
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [name, setName] = useState(product.name)
  const [price, setPrice] = useState(formatMinor(product.price_minor))
  const [busy, setBusy] = useState(false)

  async function save() {
    const minor = parseMajor(price)

    if (!name.trim()) return
    if (minor === null) return

    setBusy(true)

    try {
      if (name.trim() !== product.name) {
        await catalogApi.rename(product.id, name.trim())
      }

      if (minor !== product.price_minor) {
        await catalogApi.setPrice(product.id, minor)
      }

      onSaved()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog.edit')}>
      <div className="flex flex-col gap-4">
        <Field label={t('catalog.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label={t('catalog.price')}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>

        <p className="text-caption">{t('catalog.priceSnapshotHint')}</p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>

          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
