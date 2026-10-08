/**
 * المخزون — the manager-only notification queue.
 *
 * Reads the SQLite-persisted alert outbox the backend syncs on inventory
 * WRITES only: this component never creates anything, so refetch / rerender /
 * restart cannot duplicate. Each row is one ACTIVE product alert; recovery
 * RESOLVEs it server-side (it vanishes here) and a later fall re-arms a fresh
 * row. `read_at` flips only through the explicit buttons below — opening the
 * Inventory page never marks anything read.
 */
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@/components/ui'
import { Bell, Check, CircleAlert, TriangleAlert } from '@/components/ui/icon'
import type { InventoryNotification } from '@/services/opsApi'

function kindPresentation(kind: InventoryNotification['kind']): {
  readonly variant: 'danger' | 'warning'
  readonly labelKey: string
  readonly Icon: typeof TriangleAlert
} {
  return kind === 'BELOW_MINIMUM'
    ? { variant: 'danger', labelKey: 'inventory.notifications.belowTitle', Icon: TriangleAlert }
    : { variant: 'warning', labelKey: 'inventory.notifications.atMinTitle', Icon: CircleAlert }
}

export function InventoryNotifications({
  notifications,
  unread,
  onMarkRead,
  onMarkAllRead,
  marking,
}: Readonly<{
  readonly notifications: readonly InventoryNotification[]
  readonly unread: number
  readonly onMarkRead: (id: number) => void
  readonly onMarkAllRead: () => void
  readonly marking: boolean
}>) {
  const { t } = useTranslation()

  return (
    <section
      aria-label={t('inventory.notifications.title')}
      className="rounded-lg border border-border bg-surface-card p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Bell size={18} aria-hidden className="shrink-0 text-foreground-muted" />
          <div className="min-w-0">
            <h2 className="text-section text-foreground-strong">
              {t('inventory.notifications.title')}
              {unread > 0 ? (
                <span className="ms-2 inline-flex min-w-6 items-center justify-center rounded-full bg-destructive px-1.5 text-caption font-bold tabular-nums text-white">
                  {unread}
                </span>
              ) : null}
            </h2>
            <p className="text-caption text-foreground-subtle">
              {t('inventory.notifications.hint')}
            </p>
          </div>
        </div>
        {unread > 0 ? (
          <Button variant="outline" size="sm" onClick={onMarkAllRead} disabled={marking}>
            <Check size={15} aria-hidden />
            {t('inventory.notifications.markAllRead')}
          </Button>
        ) : null}
      </div>

      {notifications.length === 0 ? (
        <p className="text-caption text-foreground-subtle">{t('inventory.notifications.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notifications.map((note) => {
            const { variant, labelKey, Icon } = kindPresentation(note.kind)
            const isRead = note.read_at !== null
            return (
              <li
                key={note.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-body flex items-center gap-1.5 font-bold">
                    <Icon
                      size={15}
                      aria-hidden
                      className={variant === 'danger' ? 'text-destructive' : 'text-warning'}
                    />
                    {note.product_name}
                    {!isRead ? (
                      <span
                        aria-label={t('inventory.notifications.unread')}
                        className="inline-block size-2 rounded-full bg-destructive"
                      />
                    ) : null}
                  </p>
                  <p className="text-caption">{t(labelKey, { name: note.product_name })}</p>
                  <p className="text-caption tabular-nums text-foreground-subtle">
                    {t('inventory.columns.quantity')}: {note.quantity} ·{' '}
                    {t('inventory.columns.min')}: {note.min_quantity}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={variant} size="sm" dot>
                    {t(
                      note.kind === 'BELOW_MINIMUM'
                        ? 'inventory.state.below'
                        : 'inventory.state.atMin',
                    )}
                  </Badge>
                  {!isRead ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onMarkRead(note.id)}
                      disabled={marking}
                      aria-label={t('inventory.notifications.markRead', {
                        name: note.product_name,
                      })}
                    >
                      <Check size={15} aria-hidden />
                      {t('inventory.notifications.markReadShort')}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
