/**
 * Catalog badge set — availability, "new", and category identity.
 *
 * Every badge here is semantic, and the three identities never borrow from each
 * other or from the employee-role palette:
 *
 *   available → success (green)      the item can be sold right now
 *   disabled  → danger  (red)        the item is NOT sellable right now
 *   new       → the "new" accent     a recent addition, availability-agnostic
 *   category  → the category palette a business grouping, not a state
 *
 * A disabled item is deliberately RED and never neutral gray: gray reads as
 * "nothing to see here", and the cashier must be able to tell at a glance that
 * an item is unavailable. The meaning never rests on color alone — each badge
 * carries its own word (متاح / موقوف / جديد) and, where useful, an icon.
 */
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Check, CircleSlash, Sparkles } from '@/components/ui/icon'
import { categoryTone } from '@/lib/category-visual'
import { cn } from '@/lib/utils'

/**
 * Operational availability. Active = success, inactive = danger (never gray),
 * and the state is announced by text and a dot as well as by hue.
 */
export function CatalogStatusBadge({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation()
  return (
    <Badge
      variant={isActive ? 'success' : 'danger'}
      size="sm"
      dot
      icon={isActive ? Check : CircleSlash}
      data-testid="catalog-status-badge"
    >
      {isActive ? t('catalog.active') : t('catalog.inactive')}
    </Badge>
  )
}

/**
 * The "new item" badge. A separate concept from availability, so it renders
 * independently: a product can be New + Available, New + Disabled, or neither.
 * The word "جديد" is always present, so the state never depends on the color.
 */
export function CatalogNewBadge() {
  const { t } = useTranslation()
  return (
    <Badge variant="new" size="sm" icon={Sparkles} data-testid="catalog-new-badge">
      {t('catalog.new')}
    </Badge>
  )
}

/**
 * Category identity. The color slot is derived deterministically from the
 * category's database id (see `lib/category-visual.ts`), so the same category
 * always looks the same and a newly created category automatically gets a
 * color without anyone styling it by hand.
 */
export function CatalogCategoryBadge({ categoryId, name }: { categoryId: number; name: string }) {
  const tone = categoryTone(categoryId)
  return (
    <span
      data-testid="catalog-category-badge"
      data-category-tone={tone.slot}
      title={name}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1',
        'text-xs font-semibold leading-none whitespace-nowrap',
        tone.background,
        tone.border,
        tone.foreground,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', tone.foreground, 'opacity-70')}
      />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}
