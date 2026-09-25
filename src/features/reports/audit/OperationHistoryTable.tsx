import { useTranslation } from 'react-i18next'
import {
  Button,
  DataTable,
  DataTableCell,
  DataTableRow,
  DisplayDateTime,
  EmployeeAvatar,
  type DataTableColumn,
} from '@/components/ui'
import { ChevronLeft } from '@/components/ui/icon'
import type { AuditEntry } from '@/services/opsApi'
import { OperationTypeBadge } from './OperationTypeBadge'
import { actionLabel, entityLabel } from './useOperationHistory'

/**
 * OperationHistoryTable — the operations log as a scannable record table.
 *
 * Row hierarchy, in reading order:
 *   1. the operation itself (its Arabic name, the strongest text on the row);
 *   2. its type, as an icon tile rather than a filled pill;
 *   3. the affected entity, the operational "what";
 *   4. who performed it, with the shared role avatar;
 *   5. when, through the central Station date/time formatter.
 *
 * Density comes from hairline separators and `py-2.5` rather than from boxes,
 * borders or oversized rows. The type column is the only tinted element, and it
 * repeats one of four tones, so the table reads as a list rather than a
 * collection of coloured chips.
 *
 * Responsive: the entity column drops below `lg` and the table scrolls
 * horizontally beneath that, but the row's own details action keeps every
 * value reachable, so nothing is lost on a narrow window.
 */
export function OperationHistoryTable({
  rows,
  onOpen,
  busy = false,
}: {
  rows: readonly AuditEntry[]
  /** Opens the details dialog for a row. */
  onOpen: (entry: AuditEntry) => void
  busy?: boolean
}) {
  const { t } = useTranslation()

  const columns: DataTableColumn[] = [
    { key: 'operation', label: t('audit.columns.operation') },
    { key: 'group', label: t('audit.columns.type'), headerClassName: 'w-44' },
    { key: 'entity', label: t('audit.columns.entity'), hideBelow: 'lg' },
    { key: 'actor', label: t('audit.columns.actor'), hideBelow: 'sm' },
    { key: 'time', label: t('audit.columns.time'), cellClassName: 'whitespace-nowrap' },
    { key: 'actions', label: t('audit.columns.actions'), headerClassName: 'w-24' },
  ]

  return (
    <DataTable caption={t('audit.title')} columns={columns} busy={busy}>
      {rows.map((entry) => (
        <DataTableRow key={entry.id} onClick={() => onOpen(entry)}>
          <DataTableCell>
            <span className="block max-w-64 truncate text-body font-bold text-foreground-strong">
              {actionLabel(t, entry.action)}
            </span>
          </DataTableCell>

          <DataTableCell>
            <OperationTypeBadge action={entry.action} />
          </DataTableCell>

          <DataTableCell className="hidden lg:table-cell">
            <span className="block text-sm text-foreground-muted">
              {entityLabel(t, entry.entity_type)}
            </span>
            {entry.entity_id ? (
              <span className="block text-xs tabular-nums text-foreground-subtle" dir="ltr">
                #{entry.entity_id}
              </span>
            ) : null}
          </DataTableCell>

          <DataTableCell className="hidden sm:table-cell">
            {entry.actor_name ? (
              <span className="flex min-w-0 items-center gap-2">
                <EmployeeAvatar role={entry.actor_role} size="sm" />
                <span className="min-w-0">
                  <span className="block max-w-32 truncate text-sm">{entry.actor_name}</span>
                  {entry.actor_role ? (
                    <span className="block text-xs text-foreground-subtle">
                      {t(`roles.${entry.actor_role}`)}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : (
              <span className="text-foreground-faint">—</span>
            )}
          </DataTableCell>

          <DataTableCell>
            <DisplayDateTime
              value={entry.created_at}
              className="text-sm text-foreground-muted"
              separator=""
              stack
            />
          </DataTableCell>

          <DataTableCell>
            {/* The row itself is clickable; this button is the keyboard- and
                screen-reader-reachable equivalent, which is why it carries a
                full accessible name rather than a bare chevron. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`${t('audit.details.open')}: ${actionLabel(t, entry.action)}`}
              title={t('audit.details.open')}
              onClick={(event) => {
                event.stopPropagation()
                onOpen(entry)
              }}
            >
              <ChevronLeft size={16} aria-hidden />
            </Button>
          </DataTableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}
