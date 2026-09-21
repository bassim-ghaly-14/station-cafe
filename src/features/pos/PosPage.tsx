/** POS screen — placeholder until WS 2.4 (tables & orders) lands. */
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/states'
import { Card, CardHeader } from '@/components/ui'

export default function PosPage() {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader title={t('nav.pos')} subtitle={t('pos.subtitleSoon')} />
      <EmptyState title={t('pos.emptySoon')} />
    </Card>
  )
}
