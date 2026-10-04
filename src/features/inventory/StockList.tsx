/**
 * المخزون — the current stock list: the page's primary operational surface.
 *
 * # What a row says, and what it deliberately does not
 *
 * A stock row states the four things an inventory question needs and nothing
 * else:
 *
 *   1. the IDENTITY — the product name, which is the minimum needed to know
 *      WHICH stock line this is;
 *   2. the QUANTITY — the number this page exists to report, and the row's
 *      visual hero on every width;
 *   3. the MINIMUM — the threshold the status is measured against, which is the
 *      stock rule rather than a product attribute;
 *   4. the STATUS and the ADJUST action.
 *
 * It deliberately does NOT print department, category or item type. Those three
 * fields arrive on the row because the backend join produces them, but they are
 * Catalog's authoritative data and Catalog already presents them properly. This
 * page answers "what is in stock and what needs attention", and re-printing the
 * product master data here is what turns an inventory screen into a second
 * catalog.
 *
 * # Two presentations, one of them mounted
 *
 * `useIsWide()` chooses between the SHARED `DataTable` and the SHARED
 * `RecordList`, which is the rule `CustomerTable`, `EmployeeTable`, `InvoiceList`
 * and `WashTicketList` already follow: a dense operational table on a desktop,
 * the same values as records on a phone, and never both at once. A CSS-hidden
 * second copy is not an option — it would stay in the accessibility tree, be
 * announced, be parsed by tests and be held twice in memory.
 *
 * The phone record reads in the order a manager acts in: status first, then
 * identity, then the quantity, then the action. The minimum sits beside the
 * quantity as the second line rather than on a line of its own.
 *
 * # The toolbar
 *
 * `FilterBar` + `ToolbarSearch` are the shared pair every other list screen
 * uses, and the filter runs entirely in the browser over the rows `list_stock`
 * already returned — that command sends the complete tracked set with no paging,
 * so there is nothing further to request and no request is made. The header
 * strip states `shown / total` so a narrowed list is never mistaken for the
 * whole one.
 */
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  DataTable,
  DataTableCell,
  DataTableRow,
  FilterBar,
  ProgressBar,
  RecordList,
  RecordListActions,
  RecordListItem,
  Select,
  TableActionButton,
  TableActionGroup,
  ToolbarSearch,
  type DataTableColumn,
} from '@/components/ui'
import { FilterX, SlidersHorizontal } from '@/components/ui/icon'
import { useIsWide } from '@/lib/use-media-query'
import type { StockRow } from '@/services/opsApi'
import {
  hasStockQuery,
  stockStatusOf,
  type StockQuery,
  type StockStatusFilter,
} from './inventoryModel'

/**
 * The status badge a row carries.
 *
 * The Arabic word is the signal and the dot is the non-colour reinforcement, so
 * the state never rests on hue alone — the same contract `CatalogStatusBadge`
 * and the roster's badges keep. `warning` for LOW and `success` for OK are the
 * existing Station semantic tones; nothing here invents a third state, because
 * the model has only two.
 */
function StockStatusBadge({ row }: Readonly<{ readonly row: StockRow }>) {
  const { t } = useTranslation()
  const low = stockStatusOf(row) === 'LOW'
  return (
    <Badge variant={low ? 'warning' : 'success'} size="sm" dot>
      {low ? t('inventory.status.low') : t('inventory.status.ok')}
    </Badge>
  )
}

/**
 * The quantity, which is the hero of the row on every width.
 *
 * `tabular-nums` comes from the shared `text-money` utility so a column of
 * figures stays comparable at a glance, and a low row is tinted with the
 * existing destructive foreground — the one colour decision the previous version
 * made, kept exactly.
 */
function Quantity({ row }: Readonly<{ readonly row: StockRow }>) {
  return (
    <span
      className={
        stockStatusOf(row) === 'LOW'
          ? 'text-money text-destructive tabular-nums'
          : 'text-money text-foreground-strong tabular-nums'
      }
    >
      {row.quantity}
    </span>
  )
}

/** The product name. The only product data this page prints. */
function ItemName({ row }: Readonly<{ readonly row: StockRow }>) {
  return <span className="text-body font-bold">{row.product_name}</span>
}

/** The DESKTOP presentation: the shared dense operational table. */
function StockTable({
  rows,
  caption,
  busy,
  onAdjust,
}: Readonly<{
  readonly rows: readonly StockRow[]
  readonly caption: string
  readonly busy: boolean
  readonly onAdjust: (row: StockRow) => void
}>) {
  const { t } = useTranslation()

  const columns: DataTableColumn[] = [
    { key: 'item', label: t('inventory.columns.item'), headerClassName: 'min-w-40' },
    { key: 'quantity', label: t('inventory.columns.quantity'), headerClassName: 'w-24' },
    { key: 'min', label: t('inventory.columns.min'), headerClassName: 'w-24', hideBelow: 'lg' },
    { key: 'status', label: t('inventory.columns.status'), headerClassName: 'w-28' },
    { key: 'action', label: t('inventory.columns.action'), headerClassName: 'w-20' },
  ]

  return (
    <DataTable caption={caption} columns={columns} busy={busy}>
      {rows.map((row) => (
        <DataTableRow key={row.product_id}>
          <DataTableCell>
            <ItemName row={row} />
          </DataTableCell>
          <DataTableCell>
            <Quantity row={row} />
          </DataTableCell>
          <DataTableCell className="text-foreground-muted tabular-nums">
            {row.min_quantity}
          </DataTableCell>
          <DataTableCell>
            <StockStatusBadge row={row} />
          </DataTableCell>
          <DataTableCell>
            <TableActionGroup>
              <TableActionButton
                tone="warning"
                aria-label={t('inventory.filters.adjustItem', { name: row.product_name })}
                title={t('inventory.filters.adjustItem', { name: row.product_name })}
                onClick={() => onAdjust(row)}
              >
                <SlidersHorizontal aria-hidden />
              </TableActionButton>
            </TableActionGroup>
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}

/**
 * The PHONE presentation: one record per stock line.
 *
 * It states the table's values in the table's own order — status, identity,
 * quantity with its threshold, then the action — and drops nothing. The name
 * WRAPS rather than truncating, because an Arabic product name cut mid-word is
 * the one thing a stock record cannot afford to lose: the user has to know which
 * item the action will act on.
 */
function StockRecordList({
  rows,
  label,
  onAdjust,
}: Readonly<{
  readonly rows: readonly StockRow[]
  readonly label: string
  readonly onAdjust: (row: StockRow) => void
}>) {
  const { t } = useTranslation()

  return (
    <RecordList aria-label={label}>
      {rows.map((row) => (
        <RecordListItem key={row.product_id}>
          {/* Status leads the record: it is the reason to be looking at the row
              at all on a screen this narrow. */}
          <StockStatusBadge row={row} />

          <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-body min-w-0 font-bold">{row.product_name}</p>
            <Quantity row={row} />
          </div>

          <p className="text-caption mt-0.5">
            {t('inventory.columns.min')}: {row.min_quantity}
          </p>

          <RecordListActions>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              aria-label={t('inventory.filters.adjustItem', { name: row.product_name })}
              onClick={() => onAdjust(row)}
            >
              <SlidersHorizontal size={16} aria-hidden />
              {t('inventory.adjust')}
            </Button>
          </RecordListActions>
        </RecordListItem>
      ))}
    </RecordList>
  )
}

/**
 * The search and status toolbar.
 *
 * The status select is the SHARED `Select`, so it carries the same surface,
 * focus ring and inline-end chevron every other filter row uses, and the reset
 * control only appears when the query is actually narrowing something — the
 * honesty rule `CustomerFilters` and `EmployeeFilters` already follow.
 *
 * Nothing here triggers a request. Both controls describe a view over the rows
 * that are already loaded.
 */
function StockFilters({
  query,
  onQueryChange,
  onReset,
}: Readonly<{
  readonly query: StockQuery
  readonly onQueryChange: (next: StockQuery) => void
  readonly onReset: () => void
}>) {
  const { t } = useTranslation()
  const narrowing = hasStockQuery(query)

  return (
    <div className="border-b border-border-subtle p-3">
      <FilterBar
        search={
          <ToolbarSearch
            value={query.query}
            onValueChange={(value) => onQueryChange({ ...query, query: value })}
            label={t('inventory.filters.searchLabel')}
            placeholder={t('inventory.filters.searchPlaceholder')}
            hint={t('inventory.filters.searchHint')}
            clearLabel={t('inventory.filters.searchClear')}
          />
        }
      >
        <Select
          aria-label={t('inventory.filters.statusLabel')}
          value={query.status}
          onChange={(event) =>
            onQueryChange({ ...query, status: event.target.value as StockStatusFilter })
          }
          className="min-w-40"
        >
          <option value="ALL">{t('inventory.filters.all')}</option>
          <option value="LOW">{t('inventory.filters.low')}</option>
          <option value="OK">{t('inventory.filters.ok')}</option>
        </Select>

        {narrowing ? (
          <Button type="button" variant="ghost" onClick={onReset}>
            <FilterX size={16} aria-hidden />
            {t('inventory.filters.reset')}
          </Button>
        ) : null}
      </FilterBar>
    </div>
  )
}

/**
 * The stock list section: the toolbar, the header strip that states what is being
 * shown, and exactly one of the two presentations.
 *
 * `rows` are the rows the page has already FILTERED — the filter lives in the
 * page's `useMemo` over the complete loaded set, so this component only has to
 * present what it is given, and this list and the attention area can never
 * disagree about which rows exist.
 */
export function StockList({
  rows,
  total,
  query,
  onQueryChange,
  onReset,
  onAdjust,
  refreshing,
}: Readonly<{
  /** The rows to render — already filtered by the page. */
  readonly rows: readonly StockRow[]
  /** How many rows the backend returned, before the filter. */
  readonly total: number
  readonly query: StockQuery
  readonly onQueryChange: (next: StockQuery) => void
  readonly onReset: () => void
  readonly onAdjust: (row: StockRow) => void
  /** A refresh is running over rows already on screen. */
  readonly refreshing: boolean
}>) {
  const { t } = useTranslation()
  const wide = useIsWide()
  const caption = t('inventory.list.caption')

  return (
    <section className="flex flex-col gap-3">
      <StockFilters query={query} onQueryChange={onQueryChange} onReset={onReset} />

      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-section text-foreground-strong">{t('inventory.list.title')}</h2>
            <p className="mt-0.5 text-caption text-foreground-subtle">{t('inventory.list.hint')}</p>
          </div>
          {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
        </div>

        {/* `aria-live` so a narrowed result count is announced rather than being
            a silent visual change. */}
        <p
          className="border-b border-border-subtle px-4 py-2 text-caption tabular-nums"
          aria-live="polite"
        >
          {t('inventory.list.resultsCount', { shown: rows.length, total })}
        </p>

        {wide ? (
          <StockTable rows={rows} caption={caption} busy={refreshing} onAdjust={onAdjust} />
        ) : (
          <StockRecordList rows={rows} label={caption} onAdjust={onAdjust} />
        )}
      </div>
    </section>
  )
}
