/** Department badge for order lines (CAFE / WASH). */
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'

type Department = 'CAFE' | 'WASH'

export function DeptBadge({ dept }: { dept: Department }) {
  const { t } = useTranslation()
  return (
    <Badge variant={dept === 'CAFE' ? 'brand' : 'info'} size="sm">
      {t(`catalog.${dept}`)}
    </Badge>
  )
}
