/**
 * Product recipes — the catalog side of raw materials.
 *
 * A recipe says how much of each raw material ONE unit of a tracked product
 * consumes (espresso = 18g coffee). Two pieces:
 *
 *   - `CatalogRecipeBadge` — a signal in the card's badge row. It reads
 *     `product.has_recipe`, which the backend computes with an
 *     `EXISTS(product_recipe_items)` subquery on the SAME payload as the
 *     rest of the card. No extra fetch, no state to drift.
 *   - `ProductRecipeDialog` — the MANAGER editor. Loads materials + the
 *     current recipe in parallel, lets the manager edit line quantities in
 *     base units, and saves the whole recipe in ONE `setRecipe` call. An
 *     empty recipe clears it; a tracked product may sell with no recipe.
 *
 * The backend refuses recipes for untracked products, so the button never
 * renders for them — `trackFirst` explains WHY, next to the disabled state,
 * rather than letting the call fail.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Dialog, DialogActions, MoneyDisplay, Select } from '@/components/ui'
import { Field, Input } from '@/components/ui/input'
import { ChefHat, Plus, Save, Trash2 } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import { recipesApi, type RawMaterial, type RecipeCostView } from '@/services/recipesApi'
import type { Product } from '@/services/posApi'

/** The recipe signal: present only when the product HAS a recipe. */
export function CatalogRecipeBadge({ product }: Readonly<{ readonly product: Product }>) {
  const { t } = useTranslation()
  if (!product.track_inventory || !product.has_recipe) return null
  return (
    <Badge variant="info" size="sm" dot icon={ChefHat} data-testid="catalog-recipe-badge">
      {t('rawmaterials.recipe.badge')}
    </Badge>
  )
}

/** One editable recipe line: a material plus base-unit quantity per product unit. */
interface DraftLine {
  rawMaterialId: number | null
  quantityBase: string
}

function toDraft(
  lines: readonly { raw_material_id: number; quantity_base: number }[],
): DraftLine[] {
  return lines.map((l) => ({
    rawMaterialId: l.raw_material_id,
    quantityBase: String(l.quantity_base),
  }))
}

const LINE_QTY_ID = 'recipe-line-qty'

export function ProductRecipeDialog({
  product,
  onClose,
  onDone,
}: Readonly<{
  readonly product: Product
  readonly onClose: () => void
  readonly onDone: () => void
}>) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  const untracked = !product.track_inventory
  const [materials, setMaterials] = useState<RawMaterial[] | null>(null)
  const [lines, setLines] = useState<DraftLine[] | null>(null)
  const [cost, setCost] = useState<RecipeCostView | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (untracked) return
    let live = true
    recipesApi
      .list(true)
      .then((rows) => {
        if (live) setMaterials(rows)
      })
      .catch((e) => {
        if (live) toast(errText(e), 'error')
      })
    recipesApi
      .getRecipe(product.id)
      .then((rows) => {
        if (live) setLines(toDraft(rows))
      })
      .catch((e) => {
        if (live) toast(errText(e), 'error')
      })
    recipesApi
      .recipeCost(product.id)
      .then((view) => {
        if (live) setCost(view)
      })
      .catch(() => {
        // Cost is informational only; a missing cost never blocks editing.
        if (live) setCost(null)
      })
    return () => {
      live = false
    }
  }, [product.id, untracked, errText, toast])

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) =>
      current === null ? current : current.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    )
  }

  function removeLine(index: number) {
    setLines((current) => (current === null ? current : current.filter((_, i) => i !== index)))
  }

  function addLine() {
    setLines((current) => [...(current ?? []), { rawMaterialId: null, quantityBase: '' }])
  }

  async function save() {
    const draft = lines ?? []
    const payload: { raw_material_id: number; quantity_base: number }[] = []
    const seen = new Set<number>()
    for (const line of draft) {
      if (line.rawMaterialId === null) {
        toast(t('rawmaterials.recipe.selectMaterial'), 'error')
        return
      }
      // One material per recipe: the backend would deterministically sum
      // repeats, but the dialog refuses them so the saved quantities are
      // exactly what the manager sees.
      if (seen.has(line.rawMaterialId)) {
        toast(t('rawmaterials.recipe.duplicateMaterial'), 'error')
        return
      }
      seen.add(line.rawMaterialId)
      const qty = Number(line.quantityBase)
      if (!Number.isInteger(qty) || qty <= 0) {
        toast(t('errors.rawmaterials.invalid_quantity'), 'error')
        return
      }
      payload.push({ raw_material_id: line.rawMaterialId, quantity_base: qty })
    }
    setSaving(true)
    try {
      await recipesApi.setRecipe(product.id, payload)
      toast(t('rawmaterials.recipe.saved'), 'success')
      onDone()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('rawmaterials.recipe.title', { name: product.name })}>
      <div className="flex flex-col gap-4">
        <p className="text-caption text-foreground-subtle">{t('rawmaterials.recipe.hint')}</p>

        {untracked ? (
          <p className="text-body text-foreground-muted">{t('rawmaterials.recipe.trackFirst')}</p>
        ) : lines === null || materials === null ? (
          <p className="text-caption">{t('app.loading')}</p>
        ) : lines.length === 0 ? (
          <p className="text-body text-foreground-muted">{t('rawmaterials.recipe.empty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {lines.map((line, index) => (
              <div key={index} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label={t('rawmaterials.recipe.material')} htmlFor={`recipe-mat-${index}`}>
                    <Select
                      id={`recipe-mat-${index}`}
                      value={line.rawMaterialId ?? ''}
                      onChange={(e) =>
                        updateLine(index, {
                          rawMaterialId: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">{t('rawmaterials.recipe.selectMaterial')}</option>
                      {materials.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} — {t('rawmaterials.unit.' + m.base_unit)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="w-28 shrink-0">
                  <Field
                    label={t('rawmaterials.recipe.quantityPerUnit')}
                    htmlFor={`${LINE_QTY_ID}-${index}`}
                  >
                    <Input
                      id={`${LINE_QTY_ID}-${index}`}
                      inputMode="numeric"
                      value={line.quantityBase}
                      onChange={(e) => updateLine(index, { quantityBase: e.target.value })}
                    />
                  </Field>
                </div>
                <Button
                  variant="destructiveGhost"
                  size="sm"
                  aria-label={t('rawmaterials.recipe.removeLine')}
                  onClick={() => removeLine(index)}
                >
                  <Trash2 size={15} aria-hidden />
                </Button>
              </div>
            ))}
          </div>
        )}

        {!untracked && lines !== null ? (
          <div>
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus size={15} aria-hidden />
              {t('rawmaterials.recipe.addLine')}
            </Button>
            <p className="mt-1 text-caption text-foreground-subtle">
              {t('rawmaterials.recipe.quantityHint')}
            </p>
          </div>
        ) : null}

        {cost !== null && cost.lines.length > 0 ? (
          <div className="rounded-md border border-border-subtle p-3">
            <p className="text-caption font-bold text-foreground-strong">
              {t('rawmaterials.recipe.cost')}
            </p>
            <div className="mt-1 flex flex-col gap-1">
              {cost.lines.map((l) => (
                <div key={l.raw_material_id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-caption">{l.raw_material_name}</span>
                  <span className="shrink-0 tabular-nums text-caption">
                    {l.cost_minor === null ? (
                      t('rawmaterials.recipe.costUnknown')
                    ) : (
                      <MoneyDisplay amount={l.cost_minor} />
                    )}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border-subtle pt-2">
              <span className="text-body font-bold">{t('rawmaterials.recipe.cost')}</span>
              <span className="font-bold tabular-nums">
                {cost.total_cost_minor === null ? (
                  <span className="text-caption">{t('rawmaterials.recipe.costUnknown')}</span>
                ) : (
                  <MoneyDisplay amount={cost.total_cost_minor} />
                )}
              </span>
            </div>
            <p className="mt-1 text-caption text-foreground-subtle">
              {t('rawmaterials.recipe.costHint')}
            </p>
          </div>
        ) : null}

        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          {untracked ? null : (
            <Button onClick={save} disabled={saving || lines === null} loading={saving}>
              {!saving ? <Save size={16} aria-hidden /> : null}
              {t('app.save')}
            </Button>
          )}
        </DialogActions>
      </div>
    </Dialog>
  )
}
