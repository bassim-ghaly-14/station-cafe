/**
 * Raw Materials — the second segment of the Inventory page.
 *
 * # Why this is a separate segment, not a second inventory system
 *
 * Product Inventory answers "how many Pepsi Cans are on the shelf"; this
 * answers "how many grams of coffee beans are left". They are DIFFERENT
 * quantities with different lifecycles, so they are shown side by side behind
 * one explicit segment switch rather than merged into one ambiguous list. The
 * switch is a real `tablist`, so assistive technology announces which segment
 * is showing and the selected tab is never carried by colour alone.
 *
 * # What this panel owns
 *
 *   1. a KPI band over the material set (count / empty / in stock),
 *   2. the material list — identity, balance in its human unit, the last
 *      known unit cost (labelled informational), and the four manager actions,
 *   3. the movement log — every change with its explicit reason,
 *   4. the dialogs for those actions.
 *
 * The panel reuses the SHARED `DataTable`/`RecordList` pair and the same
 * `useIsWide()` rule as the product list, so the two segments read as one page
 * at two widths. Nothing here touches product stock: the two domains stay
 * structurally separate in the UI exactly as they are in the schema.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DataTableCell,
  DataTableRow,
  DisplayDateTime,
  KpiGrid,
  KpiTile,
  RecordList,
  RecordListActions,
  RecordListItem,
  type DataTableColumn,
} from '@/components/ui'
import { EmptyState, ErrorState } from '@/components/states'
import { ListRowsSkeleton } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { Boxes, Check, TriangleAlert } from '@/components/ui/icon'
import { useIsWide } from '@/lib/use-media-query'
import { useErrText } from '@/lib/err'
import { recipesApi, type RawMaterial, type RawMaterialMovement } from '@/services/recipesApi'
import {
  RawMaterialDialog,
  RawMaterialMovementDialog,
  RawMaterialPurchaseDialog,
} from './RawMaterialDialogs'

const MOVEMENT_WINDOW = 40

/**
 * Format a base-unit amount for humans: a quantity exactly divisible by 1000
 * is shown in the larger unit (kg/l) with an INTEGER quotient; anything else
 * stays in base units (g/ml). Always integer arithmetic — never a float —
 * and the active i18n locale's numerals, so Arabic renders Arabic-Indic digits.
 */
export function formatQuantity(amount: number, baseUnit: string, locale?: string): string {
  const lang = locale ?? (typeof navigator === 'undefined' ? 'ar-EG' : navigator.language)
  const abs = Math.abs(amount)
  const minor = baseUnit === 'GRAM' ? 'g' : 'ml'
  const major = baseUnit === 'GRAM' ? 'kg' : 'l'
  if (abs >= 1000 && abs % 1000 === 0) return `${(abs / 1000).toLocaleString(lang)} ${major}`
  return `${abs.toLocaleString(lang)} ${minor}`
}

/** The signed change of a movement, coloured by direction. */
function MovementChange({ row }: Readonly<{ readonly row: RawMaterialMovement }>) {
  const sign = row.change > 0 ? '+' : '−'
  return (
    <span
      className={
        row.change > 0
          ? 'text-money text-success tabular-nums'
          : 'text-money text-destructive tabular-nums'
      }
    >
      {sign}
      {formatQuantity(row.change, row.base_unit)}
    </span>
  )
}

/** The reason badge — readable without colour, tone follows direction. */
function MovementReason({ row }: Readonly<{ readonly row: RawMaterialMovement }>) {
  const { t } = useTranslation()
  const inbound = row.change > 0
  return (
    <Badge variant={inbound ? 'success' : 'danger'} size="sm" dot>
      {t(`rawmaterials.reason.${row.reason}`)}
    </Badge>
  )
}

/** Every manager action available on one material row. */
type MaterialAction = 'purchase' | 'adjust' | 'waste' | 'edit' | 'archive'

/** The DESKTOP presentation of the material set. */
function MaterialTable({
  rows,
  caption,
  busy,
  onAction,
}: Readonly<{
  readonly rows: readonly RawMaterial[]
  readonly caption: string
  readonly busy: boolean
  readonly onAction: (action: MaterialAction, row: RawMaterial) => void
}>) {
  const { t } = useTranslation()

  const columns: DataTableColumn[] = [
    { key: 'name', label: t('rawmaterials.columns.material'), headerClassName: 'min-w-40' },
    { key: 'qty', label: t('rawmaterials.columns.quantity'), headerClassName: 'w-32' },
    {
      key: 'cost',
      label: t('rawmaterials.columns.cost'),
      headerClassName: 'w-32',
      hideBelow: 'lg',
    },
    { key: 'actions', label: t('rawmaterials.columns.actions'), headerClassName: 'w-56' },
  ]

  return (
    <DataTable caption={caption} columns={columns} busy={busy}>
      {rows.map((row) => (
        <DataTableRow key={row.id}>
          <DataTableCell>
            <div className="min-w-0">
              <p className="text-body">{row.name}</p>
              <p className="text-caption">{t(`catalog.${row.department}`)}</p>
            </div>
          </DataTableCell>
          <DataTableCell>
            <span className="text-money font-bold tabular-nums text-foreground-strong">
              {formatQuantity(row.current_quantity, row.base_unit)}
            </span>
          </DataTableCell>
          <DataTableCell className="hidden lg:table-cell">
            {row.last_purchase_unit_cost_minor === null ? (
              <span className="text-caption">—</span>
            ) : (
              <span className="tabular-nums">
                {(row.last_purchase_unit_cost_minor / 100).toFixed(2)}{' '}
                {t('rawmaterials.unit.' + row.base_unit)}
              </span>
            )}
          </DataTableCell>
          <DataTableCell>
            <div className="flex flex-wrap justify-end gap-1">
              <Button variant="success" size="sm" onClick={() => onAction('purchase', row)}>
                {t('rawmaterials.purchase')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => onAction('adjust', row)}>
                {t('rawmaterials.adjust')}
              </Button>
              <Button variant="destructiveGhost" size="sm" onClick={() => onAction('waste', row)}>
                {t('rawmaterials.waste')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onAction('edit', row)}>
                {t('catalog.edit')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onAction('archive', row)}>
                {t('rawmaterials.archive')}
              </Button>
            </div>
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}

/** The PHONE presentation of the material set — the same five actions. */
function MaterialRecords({
  rows,
  onAction,
}: Readonly<{
  readonly rows: readonly RawMaterial[]
  readonly onAction: (action: MaterialAction, row: RawMaterial) => void
}>) {
  const { t } = useTranslation()
  return (
    <RecordList>
      {rows.map((row) => (
        <RecordListItem key={row.id}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-body font-semibold text-foreground-strong">{row.name}</p>
              <p className="text-caption">{t(`catalog.${row.department}`)}</p>
            </div>
            <span className="text-money shrink-0 font-bold tabular-nums text-foreground-strong">
              {formatQuantity(row.current_quantity, row.base_unit)}
            </span>
          </div>
          <RecordListActions>
            <Button variant="success" size="sm" onClick={() => onAction('purchase', row)}>
              {t('rawmaterials.purchase')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => onAction('adjust', row)}>
              {t('rawmaterials.adjust')}
            </Button>
            <Button variant="destructiveGhost" size="sm" onClick={() => onAction('waste', row)}>
              {t('rawmaterials.waste')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('edit', row)}>
              {t('catalog.edit')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('archive', row)}>
              {t('rawmaterials.archive')}
            </Button>
          </RecordListActions>
        </RecordListItem>
      ))}
    </RecordList>
  )
}

/**
 * The raw-material movement log — every change with its explicit reason.
 *
 * Two presentations through the same `useIsWide()` rule the product lists use.
 * Nothing is hidden behind a filter: the window is bounded and the header says
 * so, exactly like the product movement log above it.
 */
function MaterialMovements({
  rows,
  busy,
}: Readonly<{ readonly rows: readonly RawMaterialMovement[]; readonly busy: boolean }>) {
  const { t } = useTranslation()
  const wide = useIsWide()

  if (rows.length === 0) {
    return <EmptyState title={t('rawmaterials.noMovements')} />
  }

  if (!wide) {
    return (
      <RecordList>
        {rows.map((row) => (
          <RecordListItem key={row.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-body font-semibold text-foreground-strong">
                  {row.raw_material_name}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <MovementReason row={row} />
                  <span className="text-caption">
                    <DisplayDateTime value={row.created_at} />
                  </span>
                </div>
              </div>
              <MovementChange row={row} />
            </div>
          </RecordListItem>
        ))}
      </RecordList>
    )
  }

  const columns: DataTableColumn[] = [
    { key: 'item', label: t('rawmaterials.columns.material'), headerClassName: 'min-w-40' },
    { key: 'reason', label: t('rawmaterials.columns.reason'), headerClassName: 'w-32' },
    { key: 'change', label: t('rawmaterials.columns.change'), headerClassName: 'w-28' },
    {
      key: 'date',
      label: t('rawmaterials.columns.date'),
      headerClassName: 'w-36',
      hideBelow: 'lg',
    },
    {
      key: 'user',
      label: t('rawmaterials.columns.user'),
      headerClassName: 'w-32',
      hideBelow: 'xl',
    },
  ]

  return (
    <DataTable caption={t('rawmaterials.movements')} columns={columns} busy={busy}>
      {rows.map((row) => (
        <DataTableRow key={row.id}>
          <DataTableCell>
            <p className="text-body">{row.raw_material_name}</p>
          </DataTableCell>
          <DataTableCell>
            <MovementReason row={row} />
          </DataTableCell>
          <DataTableCell>
            <MovementChange row={row} />
          </DataTableCell>
          <DataTableCell className="hidden lg:table-cell">
            <span className="text-caption">
              <DisplayDateTime value={row.created_at} />
            </span>
          </DataTableCell>
          <DataTableCell className="hidden xl:table-cell">
            <span className="text-caption">{row.user_name ?? '—'}</span>
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}

/** Which dialog is open, or `null`. One at a time, like the product segment. */
type OpenDialog =
  | { kind: 'create' }
  | { kind: 'edit'; row: RawMaterial }
  | { kind: 'purchase'; row: RawMaterial }
  | { kind: 'adjust'; row: RawMaterial }
  | { kind: 'waste'; row: RawMaterial }
  | { kind: 'archive'; row: RawMaterial }

export function RawMaterialsPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const wide = useIsWide()

  const [materials, setMaterials] = useState<RawMaterial[] | null>(null)
  const [movements, setMovements] = useState<RawMaterialMovement[] | null>(null)
  const [listErr, setListErr] = useState<string | null>(null)
  const [movErr, setMovErr] = useState<string | null>(null)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const [archiving, setArchiving] = useState(false)

  const load = useCallback(() => {
    setListErr(null)
    setMovErr(null)
    recipesApi
      .list(true)
      .then(setMaterials)
      .catch((e) => {
        setListErr(errText(e))
        toast(errText(e), 'error')
      })
    recipesApi
      .movements(null, MOVEMENT_WINDOW)
      .then(setMovements)
      .catch((e) => {
        setMovErr(errText(e))
        toast(errText(e), 'error')
      })
  }, [errText, toast])

  useEffect(() => {
    // External async init, started after the first commit.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    load()
  }, [load])

  const lowCount = materials?.filter((m) => m.current_quantity === 0).length ?? 0
  const okCount = (materials?.length ?? 0) - lowCount

  function handleAction(action: MaterialAction, row: RawMaterial) {
    setDialog({ kind: action, row })
  }

  async function confirmArchive(row: RawMaterial) {
    setArchiving(true)
    try {
      await recipesApi.archive(row.id)
      toast(t('rawmaterials.archived'), 'success')
      setDialog(null)
      load()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setArchiving(false)
    }
  }

  const closeAndReload = () => {
    setDialog(null)
    load()
  }

  /**
   * The material body: loading skeleton, error-with-retry, the deliberately
   * rare empty state, then the wide/narrow presentation of the SET. Split from
   * the panel to keep each decision on its own early return, in the same order
   * the ternary chain it replaces occupied.
   */
  function renderMaterialList() {
    if (materials === null) {
      return listErr ? (
        <ErrorState message={listErr} onRetry={load} retryLabel={t('app.retry')} />
      ) : (
        <ListRowsSkeleton rows={4} />
      )
    }
    if (materials.length === 0) {
      return (
        <EmptyState
          title={t('rawmaterials.empty')}
          action={<p className="text-caption">{t('rawmaterials.emptyHint')}</p>}
        />
      )
    }
    if (wide) {
      return (
        <MaterialTable
          rows={materials}
          caption={t('rawmaterials.title')}
          busy={false}
          onAction={handleAction}
        />
      )
    }
    return <MaterialRecords rows={materials} onAction={handleAction} />
  }

  return (
    <div className="flex flex-col gap-4" data-testid="raw-materials-panel">
      {/* KPI band — the same shared KpiGrid/KpiTile the product segment uses,
          with the same icon/label/hint shape, so the two bands read as one
          page. The labels are deliberately about MATERIALS, never products. */}
      <KpiGrid>
        <KpiTile
          icon={<Boxes size={13} aria-hidden />}
          label={t('rawmaterials.kpi.materials')}
          hint={t('rawmaterials.kpi.materialsHint')}
        >
          <span className="tabular-nums">{materials?.length ?? '—'}</span>
        </KpiTile>
        <KpiTile
          icon={<TriangleAlert size={13} aria-hidden />}
          label={t('rawmaterials.kpi.low')}
          hint={t('rawmaterials.kpi.lowHint')}
        >
          <span className="tabular-nums">{materials === null ? '—' : lowCount}</span>
        </KpiTile>
        <KpiTile
          icon={<Check size={13} aria-hidden />}
          label={t('rawmaterials.kpi.ok')}
          hint={t('rawmaterials.kpi.okHint')}
        >
          <span className="tabular-nums">{materials === null ? '—' : okCount}</span>
        </KpiTile>
      </KpiGrid>

      <Card>
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-section text-foreground-strong">{t('rawmaterials.title')}</h2>
            <p className="mt-0.5 text-caption text-foreground-subtle">
              {t('rawmaterials.subtitle')}
            </p>
          </div>
          <Button variant="default" size="sm" onClick={() => setDialog({ kind: 'create' })}>
            {t('rawmaterials.add')}
          </Button>
        </div>

        {renderMaterialList()}
      </Card>

      <Card>
        <div className="mb-3">
          <h2 className="text-section text-foreground-strong">{t('rawmaterials.movements')}</h2>
          <p className="mt-0.5 text-caption text-foreground-subtle">
            {t('rawmaterials.movementsHint')}
          </p>
        </div>
        {movements === null ? (
          movErr ? (
            <ErrorState message={movErr} onRetry={load} retryLabel={t('app.retry')} />
          ) : (
            <ListRowsSkeleton rows={3} />
          )
        ) : (
          <MaterialMovements rows={movements} busy={false} />
        )}
      </Card>

      {dialog?.kind === 'create' ? (
        <RawMaterialDialog
          material={null}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast(t('rawmaterials.created'), 'success')
            closeAndReload()
          }}
        />
      ) : null}
      {dialog?.kind === 'edit' ? (
        <RawMaterialDialog
          material={dialog.row}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast(t('rawmaterials.updated'), 'success')
            closeAndReload()
          }}
        />
      ) : null}
      {dialog?.kind === 'purchase' ? (
        <RawMaterialPurchaseDialog
          material={dialog.row}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast(t('rawmaterials.purchased'), 'success')
            closeAndReload()
          }}
        />
      ) : null}
      {dialog?.kind === 'adjust' || dialog?.kind === 'waste' ? (
        <RawMaterialMovementDialog
          material={dialog.row}
          mode={dialog.kind === 'waste' ? 'WASTE' : 'ADJUSTMENT'}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast(t('rawmaterials.adjusted'), 'success')
            closeAndReload()
          }}
        />
      ) : null}
      {dialog?.kind === 'archive' ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          onConfirm={() => confirmArchive(dialog.row)}
          title={t('rawmaterials.archiveTitle')}
          body={t('rawmaterials.archiveConfirm', { name: dialog.row.name })}
          confirmLabel={t('rawmaterials.archive')}
          destructive
          busy={archiving}
        />
      ) : null}
    </div>
  )
}
