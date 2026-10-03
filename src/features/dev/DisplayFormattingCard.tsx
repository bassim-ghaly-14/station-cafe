/**
 * The Dev Settings "Global display formatting" card.
 *
 * PRESENTATION preferences, not cafe configuration, so this card is
 * ADMIN-only: a manager's page must not be able to restyle every screen in the
 * application.
 *
 * The controls edit a local DRAFT. Only "Save Changes" commits it to the central
 * store, so experimenting never changes the rest of the application — which is
 * why the draft and its Save belong to this card alone.
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardHeader, Field, Switch } from '@/components/ui'
import { RotateCcw, Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import {
  COMPACT_THRESHOLD_OPTIONS,
  DATE_FORMAT_OPTIONS,
  cloneFormattingPreferences,
  defaultFormattingPreferences,
  formattingPreferencesEqual,
  replaceFormattingPreferences,
  useFormattingPreferences,
  type FormattingPreferences,
} from '@/lib/formatting'
import { FormattingPreview } from './FormattingPreview'

/** Shared control styling for the formatting selects. */
const SELECT =
  'h-10 w-full rounded-md border border-border-strong bg-surface-input px-3 text-foreground focus-visible:outline-2 focus-visible:outline-focus'

export function DisplayFormattingCard() {
  const { t } = useTranslation()
  const toast = useToast()

  const saved = useFormattingPreferences()

  const [draft, setDraft] = useState<FormattingPreferences>(() => cloneFormattingPreferences(saved))

  const formattingDirty = !formattingPreferencesEqual(draft, saved)

  const patchDraft = useCallback(
    (patch: {
      money?: Partial<FormattingPreferences['money']>
      date?: Partial<FormattingPreferences['date']>
    }) => {
      setDraft((current) => ({
        ...current,
        money: { ...current.money, ...patch.money },
        date: { ...current.date, ...patch.date },
      }))
    },
    [],
  )

  const saveFormatting = () => {
    replaceFormattingPreferences(draft)

    // Re-base the draft on a detached copy so later edits never alias the store.
    setDraft(cloneFormattingPreferences(draft))

    toast(t('dev.formattingSaved'), 'success')
  }

  const resetDraft = () => {
    setDraft(cloneFormattingPreferences(saved))
  }

  // Defaults land in the DRAFT, not the store.
  const loadDefaultsIntoDraft = () => {
    setDraft(defaultFormattingPreferences())
  }

  return (
    <Card>
      <CardHeader
        title={t('dev.displayFormatting')}
        subtitle={t('dev.displayFormattingDescription')}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        {/* Right side: formatting controls */}
        <div className="flex min-w-0 flex-col gap-6 lg:order-2">
          {/* Money formatting */}
          <section className="flex flex-col gap-4">
            <h3 className="font-bold text-foreground">{t('dev.moneyFormatting')}</h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('dev.decimalPlaces')}>
                <select
                  aria-label={t('dev.decimalPlaces')}
                  className={SELECT}
                  value={draft.money.decimalPlaces}
                  onChange={(e) =>
                    patchDraft({
                      money: {
                        decimalPlaces: Number(e.target.value) as 0 | 1 | 2,
                      },
                    })
                  }
                >
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </Field>

              <Field label={t('dev.currencyPosition')}>
                <select
                  aria-label={t('dev.currencyPosition')}
                  className={SELECT}
                  value={draft.money.currencyPosition}
                  onChange={(e) =>
                    patchDraft({
                      money: {
                        currencyPosition: e.target.value as 'after' | 'before',
                      },
                    })
                  }
                >
                  <option value="after">{t('dev.currencyAfter')}</option>
                  <option value="before">{t('dev.currencyBefore')}</option>
                </select>
              </Field>
              <Field label={t('dev.compactThreshold')} hint={t('dev.compactThresholdHelp')}>
                <select
                  aria-label={t('dev.compactThreshold')}
                  className={SELECT}
                  value={draft.money.compactThreshold}
                  onChange={(e) =>
                    patchDraft({
                      money: {
                        compactThreshold: Number(e.target.value),
                      },
                    })
                  }
                >
                  {COMPACT_THRESHOLD_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value.toLocaleString('en-US')}
                    </option>
                  ))}
                </select>
              </Field>

              {/* Thousands separator */}
              <Field label={t('dev.thousandsSeparator')}>
                <div className="flex h-10 items-center gap-3">
                  <Switch
                    tone="state"
                    checked={draft.money.useThousandsSeparator}
                    onCheckedChange={(useThousandsSeparator) =>
                      patchDraft({
                        money: {
                          useThousandsSeparator,
                        },
                      })
                    }
                    label={t('dev.thousandsSeparator')}
                  />

                  <span
                    className={`
                      text-sm font-semibold
                      transition-colors duration-200
                      ${draft.money.useThousandsSeparator ? 'text-foreground-muted' : 'text-accent'}
                    `}
                  >
                    {draft.money.useThousandsSeparator ? t('app.enabled') : t('app.disabled')}
                  </span>
                </div>
              </Field>

              {/* Show currency */}
              <Field label={t('dev.showCurrency')}>
                <div className="flex h-10 items-center gap-3">
                  <Switch
                    tone="state"
                    checked={draft.money.showCurrency}
                    onCheckedChange={(showCurrency) =>
                      patchDraft({
                        money: {
                          showCurrency,
                        },
                      })
                    }
                    label={t('dev.showCurrency')}
                  />

                  <span
                    className={`
                      text-sm font-semibold
                      transition-colors duration-200
                      ${draft.money.showCurrency ? 'text-foreground-muted' : 'text-accent'}
                    `}
                  >
                    {draft.money.showCurrency ? t('app.enabled') : t('app.disabled')}
                  </span>
                </div>
              </Field>
              {/* Compact values */}
              <Field label={t('dev.compactValues')}>
                <div className="flex h-10 items-center gap-3">
                  <Switch
                    tone="state"
                    checked={draft.money.compactLargeValues}
                    onCheckedChange={(compactLargeValues) =>
                      patchDraft({
                        money: {
                          compactLargeValues,
                        },
                      })
                    }
                    label={t('dev.compactValues')}
                  />

                  <span
                    className={`
                      text-sm font-semibold
                      transition-colors duration-200
                      ${draft.money.compactLargeValues ? 'text-foreground-muted' : 'text-accent'}
                    `}
                  >
                    {draft.money.compactLargeValues ? t('app.enabled') : t('app.disabled')}
                  </span>
                </div>
              </Field>
            </div>
          </section>

          {/* Date & time formatting */}
          <section className="flex flex-col gap-4 border-t border-border pt-6">
            <h3 className="font-bold text-foreground">{t('dev.dateTimeFormatting')}</h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('dev.dateFormat')}>
                <select
                  aria-label={t('dev.dateFormat')}
                  className={SELECT}
                  value={draft.date.dateFormat}
                  onChange={(e) =>
                    patchDraft({
                      date: {
                        dateFormat: e.target.value as FormattingPreferences['date']['dateFormat'],
                      },
                    })
                  }
                >
                  {DATE_FORMAT_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t('dev.timeFormat')}>
                <select
                  aria-label={t('dev.timeFormat')}
                  className={SELECT}
                  value={draft.date.timeFormat}
                  onChange={(e) =>
                    patchDraft({
                      date: {
                        timeFormat: e.target.value as '12h' | '24h',
                      },
                    })
                  }
                >
                  <option value="24h">24h</option>
                  <option value="12h">12h</option>
                </select>
              </Field>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Field label={t('dev.showSeconds')}>
                  <div className="flex h-10 items-center gap-3">
                    <Switch
                      tone="state"
                      checked={draft.date.showSeconds}
                      onCheckedChange={(showSeconds) =>
                        patchDraft({
                          date: {
                            showSeconds,
                          },
                        })
                      }
                      label={t('dev.showSeconds')}
                    />

                    <span
                      className={`
                        text-sm font-semibold
                        transition-colors duration-200
                        ${draft.date.showSeconds ? 'text-foreground-muted' : 'text-accent'}
                      `}
                    >
                      {draft.date.showSeconds ? t('app.enabled') : t('app.disabled')}
                    </span>
                  </div>
                </Field>
              </div>
            </div>
          </section>
        </div>
        {/* Left side: live preview */}
        <section className="flex min-w-0 flex-col gap-4 lg:order-1 lg:border-s lg:border-border lg:pe-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex flex-wrap items-center gap-2 font-bold text-foreground">
              {t('dev.preview')}

              {formattingDirty ? (
                <Badge data-testid="formatting-dirty" variant="warning" size="sm" shape="pill" dot>
                  {t('dev.unsavedChanges')}
                </Badge>
              ) : null}
            </h3>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                onClick={resetDraft}
                disabled={!formattingDirty}
                data-testid="formatting-reset-draft"
              >
                <RotateCcw size={16} aria-hidden />
                {t('dev.resetChanges')}
              </Button>

              <Button
                variant="outline"
                onClick={loadDefaultsIntoDraft}
                data-testid="formatting-load-defaults"
              >
                {t('dev.resetFormatting')}
              </Button>

              <Button
                onClick={saveFormatting}
                disabled={!formattingDirty}
                data-testid="formatting-save"
              >
                <Save size={16} aria-hidden />
                {t('dev.saveFormatting')}
              </Button>
            </div>
          </div>

          <FormattingPreview draft={draft} />
        </section>
      </div>
    </Card>
  )
}
