/**
 * The Dev Settings "Tables" card.
 *
 * ADMIN-only system configuration: the number of cafe tables, with the count
 * edited locally and committed by an explicit Save. The page owns the loaded
 * value because it is also the state a reseed or a cleared database resets.
 */
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader } from '@/components/ui'
import { Minus, Plus } from '@/components/ui/icon'

export function DevTableCountCard({
  tableCount,
  onTableCountChange,
  changed,
  busy,
  onSave,
}: {
  tableCount: number
  onTableCountChange: Dispatch<SetStateAction<number>>
  changed: boolean
  busy: boolean
  onSave: () => void
}) {
  const { t } = useTranslation()

  return (
    <Card data-testid="dev-tables">
      <CardHeader title={t('dev.tables')} subtitle={t('dev.tableCountHelp')} />

      <div className="flex items-center gap-3">
        <Button
          size="icon"
          variant="outline"
          disabled={tableCount <= 1}
          aria-label={t('dev.decrease')}
          onClick={() => onTableCountChange((count) => Math.max(1, count - 1))}
        >
          <Minus size={18} aria-hidden />
        </Button>

        <output
          className="min-w-16 text-center text-3xl font-bold"
          aria-label={t('dev.tableCount')}
        >
          {tableCount}
        </output>

        <Button
          size="icon"
          variant="outline"
          disabled={tableCount >= 99}
          aria-label={t('dev.increase')}
          onClick={() => onTableCountChange((count) => Math.min(99, count + 1))}
        >
          <Plus size={18} aria-hidden />
        </Button>

        <Button disabled={!changed} loading={busy} onClick={onSave}>
          {t('app.save')}
        </Button>
      </div>
    </Card>
  )
}
