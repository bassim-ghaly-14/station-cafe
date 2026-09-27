/**
 * The customer's vehicle-status badge.
 *
 * Exactly two states, both stated in words so the meaning never depends on
 * color alone: "لديه سيارات" (has cars) and "بدون سيارات" (no cars). It is a
 * customer-domain semantic with its own tokens, deliberately NOT an employee
 * role/permission color and not a workflow state color.
 *
 * `carsCount` comes straight from the backend record — nothing is inferred in
 * the browser, and a customer with no cars is stated as a fact rather than
 * shown as an empty cell.
 */
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui'
import { Car, CarFront } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

export function CustomerVehicleBadge({
  carsCount,
  className,
}: {
  readonly carsCount: number
  readonly className?: string
}) {
  const { t } = useTranslation()
  const hasCars = carsCount > 0
  return (
    <Badge
      size="sm"
      icon={hasCars ? CarFront : Car}
      className={cn(
        hasCars
          ? 'border-customer-vehicle-has-border bg-customer-vehicle-has-bg text-customer-vehicle-has-fg'
          : 'border-customer-vehicle-none-border bg-customer-vehicle-none-bg text-customer-vehicle-none-fg',
        className,
      )}
    >
      {hasCars ? t('customers.vehicles.hasCars') : t('customers.vehicles.noCars')}
    </Badge>
  )
}
