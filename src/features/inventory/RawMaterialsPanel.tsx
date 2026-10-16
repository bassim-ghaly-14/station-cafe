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
 *   2. the material list — identity, balance in its human unit, the LAST
 *      PURCHASE cost per purchase unit (e.g. 30.00 EGP/kg), and the manager
 *      actions grouped exactly like the Customers/Employees tables,
 *   3. the movement log — every change with its explicit reason,
 *   4. the archived workspace — archived materials with a Restore action,
 *   5. the dialogs for those actions.
 *
 * The panel reuses the SHARED `DataTable`/`RecordList` pair and the same
 * `useIsWide()` rule as the product list, so the two segments read as one page
 * at two widths. Row actions use the SHARED `TableAction*` primitives and the
 * `ActionMenu` overflow — the same control the Customers table uses, not a
 * second hand-rolled action system. Nothing here touches product stock: the two
 * domains stay structurally separate in the UI exactly as they are in the schema.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ActionMenu,
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
  MoneyDisplay,
  RecordList,
  RecordListActions,
  RecordListItem,
  TableActionButton,
  TableActionGroup,
  type ActionMenuItem,
  type DataTableColumn,
} from '@/components/ui'
import { EmptyState, ErrorState } from '@/components/states'
import { ListRowsSkeleton } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import {
  Archive,
  ArchiveRestore,
  Boxes,
  Check,
  Pencil,
  ShoppingCart,
  SlidersHorizontal,
  TriangleAlert,
  Trash2,
} from '@/components/ui/icon'
import { useIsWide } from '@/lib/use-media-query'
import { useErrText } from '@/lib/err'
import { formatQuantity } from './rawMaterialsFormat'
import { recipesApi, type RawMaterial, type RawMaterialMovement } from '@/services/recipesApi'
import {
  RawMaterialDialog,
  RawMaterialMovementDialog,
  RawMaterialPurchaseDialog,
} from './RawMaterialDialogs'

const MOVEMENT_WINDOW = 40

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

/**
 * The LAST PURCHASE cost, per the unit the material was last bought in.
 *
 * It reads the exact per-purchase-unit figure the backend stores (total ÷ the
 * purchase quantity), never the per-base-unit value, so 10 kg bought for 300 EGP
 * renders "30.00 EGP / kg" rather than a per-gram rate. When a material has
 * never been purchased — or predates the stored pair — it shows an em-dash, the
 * same "no value" mark the rest of the table uses.
 */
function LastCost({ row }: Readonly<{ readonly row: RawMaterial }>) {
  const { t } = useTranslation()
  if (row.last_purchase_cost_per_unit_minor === null || row.last_purchase_unit === null) {
    return <span className="text-caption text-foreground-faint">—</span>
  }
  return (
    <span className="whitespace-nowrap tabular-nums">
      <MoneyDisplay amount={row.last_purchase_cost_per_unit_minor} />
      <span className="text-caption text-foreground-subtle">
        {' '}
        / {t('rawmaterials.unit.' + row.last_purchase_unit)}
      </span>
    </span>
  )
}

/** Every manager action available on one material row. */
type MaterialAction = 'purchase' | 'adjust' | 'waste' | 'edit' | 'archive'

/**
 * The row actions for an active material — the SHARED `TableAction*` primitives
 * and `ActionMenu` overflow the Customers table uses, so the two screens show
 * one control in one size with one spacing rule. Purchase and Edit stay directly
 * visible (the two things done with a material most often); the less frequent
 * Adjust, Waste and the irreversible Archive move behind the overflow, where the
 * destructive Archive keeps its own `danger` tone. Icon-only controls carry an
 * accessible name and tooltip naming the material, exactly like Customers.
 */
function MaterialRowActions({
  row,
  onAction,
}: Readonly<{
  readonly row: RawMaterial
  readonly onAction: (action: MaterialAction, row: RawMaterial) => void
}>) {
  const { t } = useTranslation()
  const menuItems: ActionMenuItem[] = [
    {
      key: 'adjust',
      label: t('rawmaterials.adjust'),
      icon: <SlidersHorizontal size={20} aria-hidden />,
      tone: 'info',
      onClick: () => onAction('adjust', row),
      testId: 'material-row-adjust',
    },
    {
      key: 'waste',
      label: t('rawmaterials.waste'),
      icon: <Trash2 size={20} aria-hidden />,
      tone: 'warning',
      onClick: () => onAction('waste', row),
      testId: 'material-row-waste',
    },
    {
      key: 'archive',
      label: t('rawmaterials.archive'),
      icon: <Archive size={20} aria-hidden />,
      tone: 'danger',
      onClick: () => onAction('archive', row),
      testId: 'material-row-archive',
    },
  ]
  return (
    <TableActionGroup>
      <TableActionButton
        tone="success"
        onClick={() => onAction('purchase', row)}
        aria-label={t('rawmaterials.actions.purchase', { name: row.name })}
        title={t('rawmaterials.actions.purchase', { name: row.name })}
        data-testid="material-row-purchase"
      >
        <ShoppingCart size={24} aria-hidden />
      </TableActionButton>
      <TableActionButton
        tone="warning"
        onClick={() => onAction('edit', row)}
        aria-label={t('rawmaterials.actions.edit', { name: row.name })}
        title={t('rawmaterials.actions.edit', { name: row.name })}
        data-testid="material-row-edit"
      >
        <Pencil size={24} aria-hidden />
      </TableActionButton>
      <ActionMenu items={menuItems} label={`${t('app.moreActions')}: ${row.name}`} />
    </TableActionGroup>
  )
}

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
      headerClassName: 'w-40',
      hideBelow: 'lg',
    },
    { key: 'actions', label: t('rawmaterials.columns.actions'), headerClassName: 'w-40' },
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
            <LastCost row={row} />
          </DataTableCell>
          <DataTableCell>
            <MaterialRowActions row={row} onAction={onAction} />
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
          <p className="mt-1">
            <LastCost row={row} />
          </p>
          <RecordListActions>
            <MaterialRowActions row={row} onAction={onAction} />
          </RecordListActions>
        </RecordListItem>
      ))}
    </RecordList>
  )
}

/**
 * The archived-materials workspace — where a manager restores something they
 * archived by mistake.
 *
 * It is a separate, secondary section rather than a toggle on the main list, so
 * the active catalog stays the primary surface and archived rows can never be
 * mistaken for active ones. Each row offers ONE action — Restore — through the
 * SAME `TableAction*` primitive the active rows use, so it reads as one page.
 * Restore is reversible and non-destructive, so it needs no confirmation; it
 * fires directly, exactly like the catalog's activate toggle.
 */
function ArchivedMaterials({
  rows,
  onRestore,
}: Readonly<{
  readonly rows: readonly RawMaterial[]
  readonly onRestore: (row: RawMaterial) => void
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
            <TableActionGroup>
              <TableActionButton
                tone="success"
                onClick={() => onRestore(row)}
                aria-label={t('rawmaterials.actions.restore', { name: row.name })}
                title={t('rawmaterials.actions.restore', { name: row.name })}
                data-testid="material-row-restore"
              >
                <ArchiveRestore size={24} aria-hidden />
              </TableActionButton>
            </TableActionGroup>
          </div>
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
  const [archived, setArchived] = useState<RawMaterial[]>([])
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
    // The archived workspace loads alongside the active list so a restore can
    // refresh both in one pass. A failure here is non-fatal to the active list,
    // so it never surfaces as the panel's error state.
    recipesApi
      .listArchived()
      .then(setArchived)
      .catch(() => setArchived([]))
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

  // Restore is reversible and non-destructive, so it fires directly with no
  // confirmation — the same treatment the catalog's activate toggle gets. It
  // reloads both the active list and the archived workspace so the row moves
  // back immediately and disappears from the archived section.
  async function handleRestore(row: RawMaterial) {
    try {
      await recipesApi.restore(row.id)
      toast(t('rawmaterials.restored'), 'success')
      load()
    } catch (e) {
      toast(errText(e), 'error')
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

      {/* The archived workspace. Rendered ONLY when something is archived, so the
          common case (nothing archived) shows no empty box — the same "renders
          nothing at all when nothing applies" rule the low-stock attention area
          follows above it. */}
      {archived.length > 0 ? (
        <Card>
          <div className="mb-3">
            <h2 className="text-section text-foreground-strong">{t('rawmaterials.archived')}</h2>
            <p className="mt-0.5 text-caption text-foreground-subtle">
              {t('rawmaterials.archivedHint')}
            </p>
          </div>
          <ArchivedMaterials rows={archived} onRestore={handleRestore} />
        </Card>
      ) : null}

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
