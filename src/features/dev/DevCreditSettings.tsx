/**
 * The Dev Settings "Credit" section.
 *
 * Credit is a cafe-wide setting, not a per-screen one: who may take credit and
 * from which customers. The draft lives here exactly as it lived on the page —
 * the page owns the loaded value, because the operations card's own Save
 * commits the service charge, the discount options and this together.
 */
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Field, Switch } from '@/components/ui'
import type { CreditConfig } from '@/services/posApi'

export function DevCreditSettings({
  credit,
  onCreditChange,
}: {
  credit: CreditConfig
  onCreditChange: Dispatch<SetStateAction<CreditConfig>>
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-3 md:col-span-2">
      <h3 className="font-bold text-foreground">{t('dev.credit')}</h3>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('dev.creditPolicy')}>
          <select
            className="
              h-10 w-full rounded-md
              border border-border-strong
              bg-surface-input px-3
              text-foreground
              focus-visible:outline-2
              focus-visible:outline-offset-1
              focus-visible:outline-focus
            "
            value={credit.mode}
            onChange={(e) =>
              onCreditChange({
                ...credit,
                mode: e.target.value as CreditConfig['mode'],
              })
            }
          >
            <option value="LIST">{t('dev.list')}</option>
            <option value="ALL">{t('dev.all')}</option>
          </select>
        </Field>

        <Field label={t('dev.creditEnabled')}>
          <div className="flex h-10 items-center gap-3">
            <Switch
              tone="state"
              checked={credit.enabled}
              onCheckedChange={(enabled) =>
                onCreditChange((current) => ({
                  ...current,
                  enabled,
                }))
              }
              label={t('dev.creditEnabled')}
            />

            <span
              className={`
                text-sm font-semibold
                transition-colors duration-200
                ${credit.enabled ? 'text-foreground-muted' : 'text-accent'}
              `}
            >
              {credit.enabled ? t('app.enabled') : t('app.disabled')}
            </span>
          </div>
        </Field>
      </div>
    </div>
  )
}
