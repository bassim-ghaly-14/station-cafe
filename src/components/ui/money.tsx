/** Money display — the single formatting point for minor-unit amounts. */
import { formatMinor } from '@/lib/utils'
import { cn } from '@/lib/utils'

export function MoneyDisplay({
  amount,
  className,
  currency = 'ج.م',
}: {
  amount: number
  className?: string
  currency?: string
}) {
  return (
    <span dir="ltr" className={cn('tabular-nums', className)}>
      {formatMinor(amount)} {currency}
    </span>
  )
}
