/**
 * المخزون — the stock movement log.
 *
 * # Why it is concise rather than a second product table
 *
 * A movement line answers "what changed, why, and when". It does NOT answer
 * "what does this product cost" or "which category is it in", so it prints the
 * product NAME — the minimum needed to identify the line — and nothing else from
 * the product master. Everything else on the line is movement data the backend
 * owns: the reason, the signed change, the optional note and the timestamp.
 *
 * # The window
 *
 * The page requests a bounded number of movements and the header strip SAYS SO,
 * in words and with the number. A log that silently truncates reads as a
 * complete history, and a manager acting on "nothing moved today" deserves to
 * know they are looking at the most recent lines rather than at everything.
 * There is no date control here because `list_stock_movements` takes a limit and
 * nothing else — offering a period filter would be a control that cannot work.
 *
 * # Two presentations
 *
 * The same `useIsWide()` rule as the stock list, using the same shared
 * `DataTable` and `RecordList`. Exactly one is mounted.
 */
import { useTranslation } from 'react-i18next'
import {
  Badge,
  DataTable,
  DataTableCell,
  DataTableRow,
  DisplayDateTime,
  ProgressBar,
  RecordList,
  RecordListItem,
  type DataTableColumn,
} from '@/components/ui'
import { useIsWide } from '@/lib/use-media-query'
import type { MovementRow } from '@/services/opsApi'
import { formatMovementChange, movementTone } from './inventoryModel'

/**
 * The change figure, in the one place both presentations render it, so the
 * desktop cell and the phone record can never disagree about its colour or its
 * sign.
 */
function MovementChange({ row }: Readonly<{ readonly row: MovementRow }>) {
  return (
    <span
      className={
        movementTone(row) === 'IN'
          ? 'text-money text-success tabular-nums'
          : 'text-money text-destructive tabular-nums'
      }
    >
      {formatMovementChange(row)}
    </span>
  )
}

/**
 * The reason badge. Its tone follows the direction of the movement, exactly as
 * the previous inline row did, while the word itself is the reason — so the
 * badge is readable without colour and a receipt is never confused with waste.
 */
function MovementReason({ row }: Readonly<{ readonly row: MovementRow }>) {
  const { t } = useTranslation()
  return (
    <Badge variant={movementTone(row) === 'IN' ? 'success' : 'danger'} size="sm" dot>
      {t(`inventory.reason.${row.reason}`)}
    </Badge>
  )
}

/**
 * The movement note, when there is one.
 *
 * The key is resolved with a fallback to the raw note, because a note is free
 * text the manager typed: a known vocabulary note (`initial_stock`,
 * `product_edit`) is translated, and anything else is shown verbatim rather
 * than replaced by a missing-key string. This is the existing convention, kept
 * unchanged.
 */
function MovementNote({ row }: Readonly<{ readonly row: MovementRow }>) {
  const { t } = useTranslation()
  if (!row.note) return null
  return <p className="text-caption">{t(['inventory.note.' + row.note, row.note])}</p>
}

/** The DESKTOP presentation of the log. */
function MovementTable({
  rows,
  caption,
  busy,
}: Readonly<{
  readonly rows: readonly MovementRow[]
  readonly caption: string
  readonly busy: boolean
}>) {
  const { t } = useTranslation()

  const columns: DataTableColumn[] = [
    { key: 'item', label: t('inventory.columns.item'), headerClassName: 'min-w-40' },
    { key: 'reason', label: t('inventory.columns.reason'), headerClassName: 'w-28' },
    { key: 'change', label: t('inventory.columns.change'), headerClassName: 'w-24' },
    {
      key: 'date',
      label: t('inventory.columns.date'),
      headerClassName: 'w-36',
      hideBelow: 'lg',
    },
  ]

  return (
    <DataTable caption={caption} columns={columns} busy={busy}>
      {rows.map((row) => (
        <DataTableRow key={row.id}>
          <DataTableCell>
            <div className="min-w-0">
              <p className="text-body">{row.product_name}</p>
              <MovementNote row={row} />
            </div>
          </DataTableCell>
          <DataTableCell>
            <MovementReason row={row} />
          </DataTableCell>
          <DataTableCell>
            <MovementChange row={row} />
          </DataTableCell>
          <DataTableCell>
            <DisplayDateTime value={row.created_at} separator="" />
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}

/**
 * The PHONE presentation of the log.
 *
 * The same four values as the table, in the same reading order, with the
 * timestamp beside the reason rather than on a column of its own — the note
 * folds under the product name so a long Arabic note wraps instead of pushing
 * the change figure off the record.
 */
function MovementRecordList({
  rows,
  label,
}: Readonly<{ readonly rows: readonly MovementRow[]; readonly label: string }>) {
  return (
    <RecordList aria-label={label}>
      {rows.map((row) => (
        <RecordListItem key={row.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body min-w-0 font-bold">{row.product_name}</p>
            <MovementChange row={row} />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <MovementReason row={row} />
            <DisplayDateTime value={row.created_at} separator="" />
          </div>

          <MovementNote row={row} />
        </RecordListItem>
      ))}
    </RecordList>
  )
}

/**
 * The movement section: its header strip — which states the window — and exactly
 * one of the two presentations.
 *
 * `window` is passed in rather than imported so the page owns the single place
 * the requested limit is decided, and the number the strip prints is by
 * construction the number that was requested.
 */
export function MovementList({
  rows,
  window,
  refreshing,
}: Readonly<{
  readonly rows: readonly MovementRow[]
  /** How many movements the page requested. */
  readonly window: number
  readonly refreshing: boolean
}>) {
  const { t } = useTranslation()
  const wide = useIsWide()
  const caption = t('inventory.movementsList.caption')

  return (
    <section className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-section text-foreground-strong">{t('inventory.movements')}</h2>
            <p className="mt-0.5 text-caption text-foreground-subtle">
              {t('inventory.movementsList.hint')}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-caption tabular-nums">
              {t('inventory.movementsList.window', { count: window })}
            </span>
            {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
          </div>
        </div>

        {wide ? (
          <MovementTable rows={rows} caption={caption} busy={refreshing} />
        ) : (
          <MovementRecordList rows={rows} label={caption} />
        )}
      </div>
    </section>
  )
}
