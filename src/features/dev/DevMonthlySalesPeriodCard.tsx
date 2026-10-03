/**
 * The Dev Settings "Monthly sales period" card.
 *
 * The window the Sales page charts month by month. It is a REPORTING window, not
 * one of the manager's operational sections, so it stays ADMIN-only. Same
 * lifecycle as the table count: an explicit save, and the select can only ever
 * offer what the server accepts.
 */
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Field, Select } from '@/components/ui'
import { MONTHLY_SALES_PERIOD_MONTHS } from '@/services/posApi'

export function DevMonthlySalesPeriodCard({
  months,
  onMonthsChange,
  changed,
  busy,
  onSave,
}: {
  months: number
  onMonthsChange: Dispatch<SetStateAction<number>>
  changed: boolean
  busy: boolean
  onSave: () => void
}) {
  const { t } = useTranslation()

  return (
    <Card data-testid="dev-monthly-period">
      <CardHeader title={t('dev.monthlySalesPeriod')} subtitle={t('dev.monthlySalesPeriodHelp')} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48">
          <Field label={t('dev.monthlySalesPeriodMonths')}>
            <Select
              aria-label={t('dev.monthlySalesPeriodMonths')}
              value={String(months)}
              onChange={(event) => onMonthsChange(Number(event.target.value))}
            >
              {MONTHLY_SALES_PERIOD_MONTHS.map((option) => (
                <option key={option} value={option}>
                  {t('dev.monthsOption', { count: option })}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Button disabled={!changed} loading={busy} onClick={onSave}>
          {t('app.save')}
        </Button>
      </div>
    </Card>
  )
}
