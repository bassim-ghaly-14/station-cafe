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
import { actionLabel, entityLabel } from './operationTypes'
import { businessHighlights, type AuditTranslate } from './operationPresentation'

/**
 * OperationHistoryTable — the operations log as a business activity history.
 *
 * Row hierarchy, in reading order:
 *   1. the operation itself (its Arabic name, the strongest text on the row);
 *   2. its business values — "1042 · 150.00 ج.م" — the "what happened" in the
 *      manager's own terms, drawn from the SAME allow-list the details view uses;
 *   3. the operation group, as an icon tile rather than a filled pill;
 *   4. who performed it, with the shared role avatar;
 *   5. when, through the central Station date/time formatter.
 *
 * ADMIN additionally gets the affected element and its internal reference
 * (`صنف` / `#55`), because auditing needs to point at the exact row — MANAGER
 * never sees that column, and never sees a stored id.
 *
 * Density comes from hairline separators and compact cells rather than from
 * boxes, borders or oversized rows. The group column is the only tinted element,
 * and it repeats a handful of tones, so the table reads as a list rather than a
 * collection of coloured chips.
 *
 * Responsive: the business-values and element columns drop on narrow viewports
 * and the table scrolls horizontally beneath that, while the row's own details
 * action keeps every value reachable — so nothing is lost on a narrow window.
 */
export function OperationHistoryTable({
  rows,
  onOpen,
  busy = false,
  canViewTechnical = false,
}: Readonly<{
  readonly rows: readonly AuditEntry[]
  /** Opens the details dialog for a row. */
  readonly onOpen: (entry: AuditEntry) => void
  readonly busy?: boolean
  /** ADMIN only: adds the affected-element column and its internal reference. */
  readonly canViewTechnical?: boolean
}>) {
  const { t } = useTranslation()
  const tr: AuditTranslate = (key, options) => (options ? t(key, options) : t(key))

  const columns: DataTableColumn[] = [
    { key: 'operation', label: t('audit.columns.operation') },
    { key: 'details', label: t('audit.columns.details'), hideBelow: 'lg' },
    { key: 'group', label: t('audit.columns.type'), headerClassName: 'w-44' },
    ...(canViewTechnical
      ? [{ key: 'entity', label: t('audit.columns.entity'), hideBelow: 'xl' as const }]
      : []),
    { key: 'actor', label: t('audit.columns.actor'), hideBelow: 'sm' },
    { key: 'time', label: t('audit.columns.time'), cellClassName: 'whitespace-nowrap' },
    { key: 'actions', label: t('audit.columns.actions'), headerClassName: 'w-24' },
  ]

  return (
    <DataTable caption={t('audit.title')} columns={columns} busy={busy}>
      {rows.map((entry) => {
        const highlights = businessHighlights(tr, entry)
        return (
          <DataTableRow key={entry.id} onClick={() => onOpen(entry)}>
            <DataTableCell>
              <span className="block max-w-64 truncate text-body font-bold text-foreground-strong">
                {actionLabel(t, entry.action)}
              </span>
            </DataTableCell>

            <DataTableCell className="hidden lg:table-cell">
              {highlights ? (
                <span className="block max-w-72 truncate text-sm text-foreground-muted">
                  {highlights}
                </span>
              ) : (
                <span className="text-foreground-faint">—</span>
              )}
            </DataTableCell>

            <DataTableCell>
              <OperationTypeBadge action={entry.action} />
            </DataTableCell>
            {/* The affected element and its stored reference are audit data, not
                business data: ADMIN only, and the reference is LTR-isolated
                because it is a technical number inside RTL text. */}
            {canViewTechnical ? (
              <DataTableCell className="hidden xl:table-cell">
                <span className="block text-sm text-foreground-muted">
                  {entityLabel(t, entry.entity_type)}
                </span>
                {entry.entity_id ? (
                  <span className="block text-xs tabular-nums text-foreground-subtle" dir="ltr">
                    #{entry.entity_id}
                  </span>
                ) : null}
              </DataTableCell>
            ) : null}

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
        )
      })}
    </DataTable>
  )
}
