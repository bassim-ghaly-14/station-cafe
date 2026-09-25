import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { OPERATION_GROUPS, operationGroupLabelKey, operationGroupOf } from './operationTypes'

/**
 * OperationTypeBadge — the operation type's visual identity.
 *
 * One component, one job: give an operation type a recognisable icon and a
 * consistent colour, and let the row's text stay plain. It deliberately does
 * NOT render a filled pill per row — the icon tile plus plain type text keeps
 * a long log calm, while the tone still lets a reader group rows at a glance.
 *
 * `size="sm"` is the table form; `size="md"` is the details-dialog form.
 */
export function OperationTypeBadge({
  action,
  size = 'sm',
  className,
}: {
  /** The raw recorded action code, e.g. `invoice.created`. Never rendered. */
  action: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const { t } = useTranslation()
  const group = operationGroupOf(action)
  const { icon: Icon, tone } = OPERATION_GROUPS[group]

  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center',
          size === 'sm' ? 'size-7 rounded-md' : 'size-9 rounded-lg',
          TONE_TILE[tone],
        )}
      >
        <Icon size={size === 'sm' ? 15 : 17} />
      </span>
      <span
        className={cn(
          'min-w-0 truncate font-medium text-foreground-muted',
          size === 'sm' ? 'text-xs' : 'text-sm',
        )}
      >
        {t(operationGroupLabelKey(group))}
      </span>
    </span>
  )
}

/**
 * Icon-tile surfaces per tone. These reuse the same semantic badge tokens the
 * rest of the app uses for status, so no second colour system is introduced
 * and light/dark stay in step.
 */
const TONE_TILE: Record<string, string> = {
  neutral: 'bg-surface-muted text-foreground-muted',
  brand: 'bg-primary-soft text-primary',
  info: 'bg-info-soft text-info-foreground',
  success: 'bg-success-soft text-success-foreground',
  warning: 'bg-warning-soft text-warning-foreground',
  danger: 'bg-destructive-soft text-destructive-soft-foreground',
}
