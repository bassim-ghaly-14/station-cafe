/** Shared presentation boundary for domain values stored in piasters. */
import { formatMinorMoney, type MoneyVariant } from '@/lib/money'
import { useFormattingPreferences } from '@/lib/formatting'
import { cn } from '@/lib/utils'

export function MoneyDisplay({
  amount,
  className,
  compact = false,
  variant,
}: {
  amount: number
  className?: string
  /** Legacy compact flag — forces compact. Prefer `variant` in new code. */
  compact?: boolean
  /**
   * Semantic variant. Default `full` (exact — POS/invoices/day-closing).
   * Summaries (KPIs/charts) should pass `variant="auto"` so the global
   * Dev Settings switch controls compact presentation.
   */
  variant?: MoneyVariant
}) {
  // Subscribe so global Dev Settings changes re-render immediately.
  useFormattingPreferences()
  return (
    <span dir="ltr" className={cn('tabular-nums', className)}>
      {formatMinorMoney(amount, { compact, variant })}
    </span>
  )
}
