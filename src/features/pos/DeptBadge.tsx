/** Department badge for order lines (CAFE / WASH). */
import { Badge } from '@/components/ui/card'

type Department = 'CAFE' | 'WASH'

function deptTone(dept: Department): 'info' | 'warning' {
  return dept === 'CAFE' ? 'info' : 'warning'
}

export function DeptBadge({ dept }: { dept: Department }) {
  return <Badge tone={deptTone(dept)}>{dept === 'CAFE' ? 'كافيه' : 'مغسلة'}</Badge>
}
