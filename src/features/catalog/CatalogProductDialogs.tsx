/**
 * The catalog's category and product forms.
 *
 * The category form is ONE component for both adding and renaming: a rename is
 * the same decision as a create — one name field, the same emptiness and
 * uniqueness rules, the same footer, the same busy and error handling — so it
 * is the same component with a different title and a pre-filled field. The Add
 * and Edit product dialogs share their identity preview, item-type selector and
 * new-item switch for the same reason: a second copy would drift.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogActions } from '@/components/ui'
import { Field, Input, Label, Switch } from '@/components/ui/input'
import { Coffee, Droplets, Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'

import { useErrText } from '@/lib/err'
import { formatMinorMoneyInput } from '@/lib/money'
import { parseMajor } from '@/lib/utils'

import { catalogApi, type Category, type NewProductInput } from '@/services/catalogApi'
import type { Product } from '@/services/posApi'

import type { Department, ItemType } from './catalogModel'
import { DEPARTMENTS, TYPES, departmentStyles, parseStockQuantity } from './catalogVisual'

/**
 * The ONE category form, used for both adding and renaming.
 *
 * A rename is the same decision as a create — one name field, the same
 * emptiness and uniqueness rules, the same save/cancel footer and the same busy
 * and error handling — so it is the SAME component with a different title, the
 * field pre-filled with the category being edited, and the duplicate check
 * ignoring that category's own current name. A second form would be a copy that
 * drifts.
 */
export function CategoryDialog({
  existingCategories,
  category,
  onClose,
  onSaved,
}: {
  readonly existingCategories: Category[]
  /** The category being renamed; `null` means "add a new category". */
  readonly category: Category | null
  readonly onClose: () => void
  readonly onSaved: (name: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [name, setName] = useState(category?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('catalog.categoryNameRequired'))
      return
    }
    if (
      existingCategories.some(
        (existing) =>
          existing.id !== category?.id &&
          existing.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
      )
    ) {
      setError(t('catalog.categoryNameTaken'))
      return
    }

    setBusy(true)
    try {
      if (category) {
        await catalogApi.updateCategory(category.id, trimmed)
      } else {
        await catalogApi.createCategory(trimmed)
      }
      onSaved(trimmed)
    } catch (cause) {
      setError(errText(cause))
      toast(errText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? t('catalog.editCategory') : t('catalog.addCategory')}
    >
      <div className="flex flex-col gap-5">
        <Field label={t('catalog.categoryName')} error={error}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) void save()
            }}
          />
        </Field>
        <DialogActions className="border-t border-border pt-4">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}

/* ========================================================================== */
/* New-item switch                                                            */
/* ========================================================================== */

/**
 * The "is this a new item?" control, shared by the Add and Edit dialogs so the
 * two can never drift apart.
 *
 * Accessibility: the visible label is associated with the switch via `htmlFor`,
 * so the control has a real accessible name in Arabic, and the switch itself is
 * a `role="switch"` button — reachable with Tab, toggled with Space or Enter,
 * and announcing its ON/OFF state. The hint spells out that this is a display
 * badge and does NOT affect availability, which is the question a manager
 * actually has when looking at this control.
 */
function NewItemSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean
  readonly onChange: (value: boolean) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-surface-muted p-3">
      <div className="min-w-0">
        <Label
          htmlFor="catalog-is-new"
          className="block text-base font-bold text-foreground-strong"
        >
          {t('catalog.newItem')}
        </Label>
        <p className="text-caption mt-0.5">{t('catalog.newItemHint')}</p>
      </div>

      {/* Explicitly the NEW accent, not the default: this is the dialog field
          that MARKS an item as new, so its ON state must keep matching the
          magenta NEW card frame, edge, and ribbon this switch produces. The
          category manager's visibility switch is a plain condition and uses
          tone="state" instead — the two are deliberately different meanings. */}
      <Switch
        id="catalog-is-new"
        checked={checked}
        onCheckedChange={onChange}
        label={t('catalog.newItem')}
        tone="new"
      />
    </div>
  )
}

/* ========================================================================== */
/* Create dialog                                                              */
/* ========================================================================== */

export function CreateProductDialog({
  categories,
  onClose,
  onCreated,
}: {
  readonly categories: Category[]
  readonly onClose: () => void
  readonly onCreated: (name: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  const [name, setName] = useState('')
  const [type, setType] = useState<ItemType>('PRODUCT')
  const [department, setDepartment] = useState<Department>('CAFE')
  const [price, setPrice] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [tracked, setTracked] = useState(false)
  const [stockQuantity, setStockQuantity] = useState('0')
  const [stockError, setStockError] = useState<string | null>(null)
  const [minQuantity, setMinQuantity] = useState('0')
  const [minStockError, setMinStockError] = useState<string | null>(null)
  // A brand-new catalog entry is the "new" case by default: the manager is
  // creating it right now, so badging it is what they almost always want.
  const [isNew, setIsNew] = useState(true)

  const [busy, setBusy] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)

  const departmentStyle = departmentStyles[department]

  async function save() {
    const minor = parseMajor(price)

    if (!name.trim()) {
      return
    }

    if (minor === null) {
      setPriceError(t('catalog.invalidPrice'))
      return
    }

    if (!categoryId) {
      setCategoryError(t('catalog.categoryRequired'))
      return
    }

    const quantity = type === 'PRODUCT' && tracked ? parseStockQuantity(stockQuantity) : null
    if (type === 'PRODUCT' && tracked && quantity === null) {
      setStockError(t('catalog.invalidStock'))
      return
    }

    const min = type === 'PRODUCT' && tracked ? parseStockQuantity(minQuantity) : null
    if (type === 'PRODUCT' && tracked && min === null) {
      setMinStockError(t('errors.inventory.invalid_min'))
      return
    }

    setBusy(true)

    try {
      const input: NewProductInput = {
        name: name.trim(),
        item_type: type,
        department,
        category_id: Number(categoryId),
        price_minor: minor,
        track_inventory: type === 'PRODUCT' && tracked,
        stock_quantity: quantity,
        // Atomic: minimum travels INSIDE the create payload, so a failed
        // create leaves no orphan product and a failed minimum leaves no
        // product without its threshold.
        min_quantity: min,
        is_new: isNew,
      }

      await catalogApi.create(input)

      onCreated(input.name)
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog.add')}>
      <div className="flex flex-col gap-5">
        {/* Identity preview */}
        <div
          className={[
            'relative overflow-hidden border p-4',
            departmentStyle.soft,
            departmentStyle.border,
          ].join(' ')}
        >
          <div className={['absolute inset-y-0 inset-s-0 w-1', departmentStyle.accent].join(' ')} />

          <div className="flex items-center gap-3 ps-2">
            <div
              className={[
                'flex h-11 w-11 items-center justify-center border bg-surface',
                departmentStyle.border,
                departmentStyle.accentText,
              ].join(' ')}
            >
              {department === 'CAFE' ? (
                <Coffee size={22} strokeWidth={1.8} aria-hidden />
              ) : (
                <Droplets size={22} strokeWidth={1.8} aria-hidden />
              )}
            </div>

            <div>
              <p
                className={[
                  'text-[10px] font-black uppercase tracking-[0.18em]',
                  departmentStyle.accentText,
                ].join(' ')}
              >
                {t(`catalog.${department}`)}
              </p>

              <p className="text-body mt-0.5 font-bold">{t(`catalog.${type}`)}</p>
            </div>
          </div>
        </div>

        <Field label={t('catalog.name')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('catalog.department')}>
            <select
              value={department}
              onChange={(event) => setDepartment(event.target.value as Department)}
              className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
            >
              {DEPARTMENTS.map((value) => (
                <option key={value} value={value}>
                  {t(`catalog.${value}`)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('catalog.type')}>
            <select
              value={type}
              onChange={(event) => {
                const value = event.target.value as ItemType
                setType(value)
                if (value === 'SERVICE') {
                  setTracked(false)
                  setStockError(null)
                }
              }}
              className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
            >
              {TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`catalog.${value}`)}
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
            onChange={(event) => {
              setPrice(event.target.value)
              setPriceError(null)
            }}
            placeholder="0.00"
          />
        </Field>

        <Field label={t('catalog.category')} error={categoryError}>
          <select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value)
              setCategoryError(null)
            }}
            className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
          >
            <option value="">{t('catalog.selectCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        {type === 'PRODUCT' ? (
          <label className="text-body flex items-center gap-2">
            <input
              type="checkbox"
              checked={tracked}
              onChange={(event) => {
                setTracked(event.target.checked)
                setStockError(null)
              }}
              className="h-4 w-4 accent-primary"
            />
            {t('inventory.trackItem')}
          </label>
        ) : null}

        <NewItemSwitch checked={isNew} onChange={setIsNew} />

        {type === 'PRODUCT' && tracked ? (
          <>
            <Field
              label={t('inventory.currentQuantity')}
              error={stockError}
              hint={t('inventory.initialStockHint')}
              htmlFor="catalog-stock-quantity"
            >
              <Input
                id="catalog-stock-quantity"
                dir="ltr"
                inputMode="numeric"
                value={stockQuantity}
                onChange={(event) => {
                  setStockQuantity(event.target.value)
                  setStockError(null)
                }}
                placeholder="0"
              />
            </Field>

            <Field
              label={t('inventory.minimumStock')}
              error={minStockError}
              hint={t('inventory.minimumStockHint')}
              htmlFor="catalog-min-quantity"
            >
              <Input
                id="catalog-min-quantity"
                dir="ltr"
                inputMode="numeric"
                value={minQuantity}
                onChange={(event) => {
                  setMinQuantity(event.target.value)
                  setMinStockError(null)
                }}
                placeholder="0"
              />
            </Field>
          </>
        ) : null}

        <DialogActions className="border-t border-border pt-4">
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

/* ========================================================================== */
/* Edit dialog                                                                */
/* ========================================================================== */

export function EditProductDialog({
  product,
  categories,
  onClose,
  onSaved,
}: {
  readonly product: Product
  readonly categories: Category[]
  readonly onClose: () => void
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  const [name, setName] = useState(product.name)

  const [price, setPrice] = useState(formatMinorMoneyInput(product.price_minor))
  const [categoryId, setCategoryId] = useState(String(product.category_id))
  const [tracked, setTracked] = useState(product.track_inventory)
  const [stockQuantity, setStockQuantity] = useState(String(product.stock_quantity))
  const [minQuantity, setMinQuantity] = useState(String(product.min_quantity ?? 0))
  const [minStockError, setMinStockError] = useState<string | null>(null)
  // Seeded from the PERSISTED value, so editing never silently flips the flag.
  const [isNew, setIsNew] = useState(product.is_new)

  const [busy, setBusy] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)

  const department = product.department as Department
  const style = departmentStyles[department]

  async function save() {
    const minor = parseMajor(price)

    if (!name.trim()) {
      return
    }

    if (minor === null) {
      setPriceError(t('catalog.invalidPrice'))
      return
    }
    if (!categoryId) {
      setCategoryError(t('catalog.categoryRequired'))
      return
    }

    const quantity =
      product.item_type === 'PRODUCT' && tracked ? parseStockQuantity(stockQuantity) : null
    if (product.item_type === 'PRODUCT' && tracked && quantity === null) {
      setStockError(t('catalog.invalidStock'))
      return
    }

    const min = product.item_type === 'PRODUCT' && tracked ? parseStockQuantity(minQuantity) : null
    if (product.item_type === 'PRODUCT' && tracked && min === null) {
      setMinStockError(t('errors.inventory.invalid_min'))
      return
    }

    setBusy(true)

    try {
      await catalogApi.update(product.id, {
        name: name.trim(),
        item_type: product.item_type,
        department: product.department,
        category_id: Number(categoryId),
        price_minor: minor,
        track_inventory: product.item_type === 'PRODUCT' && tracked,
        stock_quantity: quantity,
        // Atomic like create: quantity and minimum are independent fields of
        // ONE payload, so one cannot silently rewrite the other and the
        // backend persists both in ONE transaction.
        min_quantity: min,
        is_new: isNew,
      })

      onSaved()
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog.edit')}>
      <div className="flex flex-col gap-5">
        {/* Current identity */}
        <div
          className={['relative overflow-hidden border p-4', style.soft, style.border].join(' ')}
        >
          <div className={['absolute inset-y-0 inset-s-0 w-1', style.accent].join(' ')} />

          <div className="flex items-center gap-3 ps-2">
            <div
              className={[
                'flex h-11 w-11 items-center justify-center border bg-surface',
                style.border,
                style.accentText,
              ].join(' ')}
            >
              {department === 'CAFE' ? (
                <Coffee size={22} strokeWidth={1.8} aria-hidden />
              ) : (
                <Droplets size={22} strokeWidth={1.8} aria-hidden />
              )}
            </div>

            <div className="min-w-0">
              <p
                className={[
                  'text-[10px] font-black uppercase tracking-[0.18em]',
                  style.accentText,
                ].join(' ')}
              >
                {t(`catalog.${department}`)}
              </p>

              <p className="text-body mt-0.5 truncate font-bold">{product.name}</p>
            </div>
          </div>
        </div>

        <Field label={t('catalog.name')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field label={t('catalog.category')} error={categoryError}>
          <select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value)
              setCategoryError(null)
            }}
            className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
          >
            <option value="">{t('catalog.selectCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        {product.item_type === 'PRODUCT' ? (
          <label className="text-body flex items-center gap-2">
            <input
              type="checkbox"
              checked={tracked}
              onChange={(event) => {
                setTracked(event.target.checked)
                setStockError(null)
                setMinStockError(null)
              }}
              className="h-4 w-4 accent-primary"
            />
            {t('inventory.trackItem')}
          </label>
        ) : null}

        <NewItemSwitch checked={isNew} onChange={setIsNew} />

        {product.item_type === 'PRODUCT' && tracked ? (
          <>
            <Field
              label={t('inventory.currentQuantity')}
              error={stockError}
              hint={t('inventory.stockEditHint')}
              htmlFor="catalog-edit-stock-quantity"
            >
              <Input
                id="catalog-edit-stock-quantity"
                dir="ltr"
                inputMode="numeric"
                value={stockQuantity}
                onChange={(event) => {
                  setStockQuantity(event.target.value)
                  setStockError(null)
                }}
                placeholder="0"
              />
            </Field>

            <Field
              label={t('inventory.minimumStock')}
              error={minStockError}
              hint={t('inventory.minimumStockHint')}
              htmlFor="catalog-edit-min-quantity"
            >
              <Input
                id="catalog-edit-min-quantity"
                dir="ltr"
                inputMode="numeric"
                value={minQuantity}
                onChange={(event) => {
                  setMinQuantity(event.target.value)
                  setMinStockError(null)
                }}
                placeholder="0"
              />
            </Field>
          </>
        ) : null}

        <Field label={t('catalog.price')} error={priceError}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value)
              setPriceError(null)
            }}
          />
        </Field>

        <p className="text-caption">{t('catalog.priceSnapshotHint')}</p>

        <DialogActions className="border-t border-border pt-4">
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
