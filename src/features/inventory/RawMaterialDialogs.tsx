/**
 * Raw materials — the dialogs the Raw Materials segment owns.
 *
 * Three mutations, each with its own rules stated next to its own field:
 *
 *  - IDENTITY (create/edit): name, department and the BASE unit the material
 *    is stored in. The base unit is the normalization anchor (GRAM or
 *    MILLILITER), so it is a closed selector — never free text.
 *  - PURCHASE: the manager types the quantity in the unit they BUY in and the
 *    TOTAL they paid. The conversion to base units happens in the backend, and
 *    the total is entered directly so it can never be scaled twice by the
 *    normalized quantity. This is the ambiguity correction made concrete.
 *  - MOVEMENT (adjust / waste): a signed adjustment or a waste quantity, each
 *    carrying its reason to the backend, which refuses a negative result.
 *
 * Money goes through the shared `parseMajor` (major → integer minor units) so
 * the whole application parses amounts one way.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogActions, Select } from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import { parseMajor } from '@/lib/utils'
import {
  recipesApi,
  type MaterialUnit,
  type NewMaterialInput,
  type RawMaterial,
} from '@/services/recipesApi'

const NAME_ID = 'rm-name'
const DEPT_ID = 'rm-dept'
const UNIT_ID = 'rm-unit'
const QTY_ID = 'rm-qty'
const PURCHASE_UNIT_ID = 'rm-purchase-unit'
const COST_ID = 'rm-cost'
const NOTE_ID = 'rm-note'

/** Which family of purchase units a base unit accepts (mass vs volume). */
function purchaseUnitsFor(baseUnit: string): readonly MaterialUnit[] {
  return baseUnit === 'GRAM' ? (['GRAM', 'KILOGRAM'] as const) : (['MILLILITER', 'LITER'] as const)
}

/** Create or edit a raw material's identity. Quantity is never touched here. */
export function RawMaterialDialog({
  material,
  onClose,
  onDone,
}: Readonly<{
  /** `null` creates a new material; otherwise the row being edited. */
  readonly material: RawMaterial | null
  readonly onClose: () => void
  readonly onDone: (created: boolean) => void
}>) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const editing = material !== null
  // A stocked material keeps its unit: the backend refuses the change
  // atomically, and the selector is locked here so the manager is never
  // invited to submit it. A zero-stock material that is still referenced by
  // a recipe is refused by the backend with `unit_locked` (see hint below).
  const unitLocked = editing && (material?.current_quantity ?? 0) !== 0
  const [name, setName] = useState(material?.name ?? '')
  const [department, setDepartment] = useState<'CAFE' | 'WASH'>(material?.department ?? 'CAFE')
  const [baseUnit, setBaseUnit] = useState<'GRAM' | 'MILLILITER'>(material?.base_unit ?? 'GRAM')
  const [busy, setBusy] = useState(false)

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast(t('errors.rawmaterials.name_required'), 'error')
      return
    }
    const input: NewMaterialInput = { name: trimmed, department, base_unit: baseUnit }
    setBusy(true)
    try {
      if (editing) await recipesApi.update(material.id, input)
      else await recipesApi.create(input)
      onDone(!editing)
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? t('rawmaterials.editTitle') : t('rawmaterials.addTitle')}
    >
      <div className="flex flex-col gap-4">
        <Field label={t('rawmaterials.name')} htmlFor={NAME_ID}>
          <Input
            id={NAME_ID}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('rawmaterials.namePlaceholder')}
          />
        </Field>
        <Field label={t('rawmaterials.department')} htmlFor={DEPT_ID}>
          <Select
            id={DEPT_ID}
            value={department}
            onChange={(e) => setDepartment(e.target.value as 'CAFE' | 'WASH')}
          >
            <option value="CAFE">{t('catalog.CAFE')}</option>
            <option value="WASH">{t('catalog.WASH')}</option>
          </Select>
        </Field>
        <Field label={t('rawmaterials.baseUnit')} htmlFor={UNIT_ID}>
          <Select
            id={UNIT_ID}
            value={baseUnit}
            disabled={unitLocked}
            onChange={(e) => setBaseUnit(e.target.value as 'GRAM' | 'MILLILITER')}
          >
            <option value="GRAM">{t('rawmaterials.unit.GRAM')}</option>
            <option value="MILLILITER">{t('rawmaterials.unit.MILLILITER')}</option>
          </Select>
          <p className="text-caption">
            {unitLocked ? t('rawmaterials.baseUnitLocked') : t('rawmaterials.baseUnitHint')}
          </p>
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

/**
 * A purchase: quantity in the bought unit + the TOTAL paid.
 *
 * The two numbers are the whole contract. The backend normalizes the quantity
 * to the material's base unit and books the total as a SUPPLIES expense, so
 * entering a total here can never be multiplied again by the base quantity.
 */
export function RawMaterialPurchaseDialog({
  material,
  onClose,
  onDone,
}: Readonly<{
  readonly material: RawMaterial
  readonly onClose: () => void
  readonly onDone: () => void
}>) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const units = purchaseUnitsFor(material.base_unit)
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState<MaterialUnit>(units[units.length - 1])
  const [cost, setCost] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const qty = Number.parseInt(quantity.trim(), 10)
    if (!Number.isInteger(qty) || qty <= 0) {
      toast(t('errors.rawmaterials.invalid_quantity'), 'error')
      return
    }
    const minor = parseMajor(cost)
    if (minor === null || minor <= 0) {
      toast(t('errors.expenses.invalid_amount'), 'error')
      return
    }
    setBusy(true)
    try {
      await recipesApi.purchase({
        raw_material_id: material.id,
        quantity: qty,
        purchase_unit: unit,
        total_cost_minor: minor,
        note: note.trim() || null,
      })
      onDone()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('rawmaterials.purchaseTitle', { name: material.name })}>
      <div className="flex flex-col gap-4">
        <Field label={t('rawmaterials.purchaseQuantity')} htmlFor={QTY_ID}>
          <Input
            id={QTY_ID}
            dir="ltr"
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          <p className="text-caption">{t('rawmaterials.purchaseQuantityHint')}</p>
        </Field>
        <Field label={t('rawmaterials.purchaseUnit')} htmlFor={PURCHASE_UNIT_ID}>
          <Select
            id={PURCHASE_UNIT_ID}
            value={unit}
            onChange={(e) => setUnit(e.target.value as MaterialUnit)}
          >
            {units.map((u) => (
              <option key={u} value={u}>
                {t(`rawmaterials.unit.${u}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('rawmaterials.totalCost')} htmlFor={COST_ID}>
          <Input
            id={COST_ID}
            dir="ltr"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="0.00"
          />
          <p className="text-caption">{t('rawmaterials.totalCostHint')}</p>
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
            {t('rawmaterials.purchase')}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}

/**
 * A movement: a signed ADJUSTMENT or a WASTE quantity.
 *
 * One dialog because the two share every field and differ only in sign and
 * reason; the mode decides which command is called and which hint is shown.
 * A waste is a positive quantity sent as a decrease; an adjustment carries its
 * own sign, and the backend refuses any result that would go negative.
 */
export function RawMaterialMovementDialog({
  material,
  mode,
  onClose,
  onDone,
}: Readonly<{
  readonly material: RawMaterial
  readonly mode: 'ADJUSTMENT' | 'WASTE'
  readonly onClose: () => void
  readonly onDone: () => void
}>) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const isWaste = mode === 'WASTE'
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const n = Number.parseInt(value.trim(), 10)
    if (!Number.isInteger(n) || n === 0 || (isWaste && n < 0)) {
      toast(
        t(isWaste ? 'errors.rawmaterials.invalid_quantity' : 'errors.rawmaterials.zero_change'),
        'error',
      )
      return
    }
    setBusy(true)
    try {
      if (isWaste) await recipesApi.waste(material.id, n, note.trim() || null)
      else await recipesApi.adjust(material.id, n, note.trim() || null)
      onDone()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t(isWaste ? 'rawmaterials.wasteTitle' : 'rawmaterials.adjustTitle', {
        name: material.name,
      })}
    >
      <div className="flex flex-col gap-4">
        <Field label={t('rawmaterials.quantity')} htmlFor={QTY_ID}>
          <Input
            id={QTY_ID}
            dir="ltr"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="text-caption">
            {t(isWaste ? 'rawmaterials.wasteHint' : 'rawmaterials.adjustHint')}
          </p>
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
