/**
 * The Dev Settings "Chart bar colours" card.
 *
 * It is the ONLY place a chart colour is ever written. The controls edit an
 * unsaved DRAFT, exactly like the formatting card next to it, and "Save" hands
 * the draft to the central settings store — the store publishes it onto the
 * `--chart-bar-*` custom properties, and every chart in the application repaints
 * itself. No chart is told, re-rendered or re-configured, and there is no second
 * place a colour can be changed from.
 *
 * Reuses the page's own pieces (`Card`, `CardHeader`, `Field`, `Input`, `Button`,
 * `Badge`, the dirty badge and the reset/save wording) rather than introducing a
 * new control pattern, and every word on screen is a translation key.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardHeader, Field, Input } from '@/components/ui'
import { RotateCcw } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import {
  CHART_COLOR_ROLES,
  CHART_COLOR_VARIABLES,
  DEFAULT_CHART_COLORS,
  chartColorsEqual,
  isChartColorValue,
  resolveChartColor,
} from '@/lib/chart-colors'
import type { ChartColorRole, ChartColorSettings } from '@/lib/chart-colors-types'
import {
  getChartColorSettings,
  resetChartColorSettings,
  setChartColorSettings,
  useFormattingPreferences,
} from '@/lib/formatting'

/** A detached copy, so a draft can never alias the store. */
function clone(source: ChartColorSettings): ChartColorSettings {
  return { ...source }
}

type ColorErrors = Partial<Record<ChartColorRole, string>>

export function ChartColorsCard() {
  const { t } = useTranslation()
  const toast = useToast()
  // Subscribe so a colour saved elsewhere lands here without a reload.
  useFormattingPreferences()
  const saved = getChartColorSettings()

  const [draft, setDraft] = useState<ChartColorSettings>(() => clone(saved))
  const [errors, setErrors] = useState<ColorErrors>({})

  const dirty = !chartColorsEqual(draft, saved)

  const patch = (role: ChartColorRole, value: string) => {
    setDraft((current) => ({ ...current, [role]: value }))
    setErrors((current) => {
      if (!current[role] || isChartColorValue(value)) return current
      const next = { ...current }
      delete next[role]
      return next
    })
  }

  const save = () => {
    const invalid = CHART_COLOR_ROLES.filter((role) => !isChartColorValue(draft[role]))
    if (invalid.length > 0) {
      // Refuse the whole save rather than paint half of it: a half-applied colour
      // set is the one state where two charts could disagree about a bar.
      setErrors(Object.fromEntries(invalid.map((role) => [role, t('dev.chartColorInvalid')])))
      return
    }
    setErrors({})
    setChartColorSettings(draft)
    setDraft(clone(draft))
    toast(t('dev.chartColorsSaved'), 'success')
  }

  return (
    <Card data-testid="dev-chart-colors">
      <CardHeader title={t('dev.chartColors')} subtitle={t('dev.chartColorsDescription')} />

      <div className="flex flex-col gap-4">
        <p className="text-sm text-foreground-muted">{t('dev.chartColorsHowTo')}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          {CHART_COLOR_ROLES.map((role) => (
            <Field
              key={role}
              htmlFor={`chart-color-${role}`}
              label={t(`dev.chartColor_${role}`)}
              hint={t(`dev.chartColorHint_${role}`)}
              error={errors[role]}
            >
              <div className="flex items-center gap-2">
                {/* The swatch: a real `<input type="color">` pre-filled with the
                    colour this value paints AS right now, so what the developer
                    picks is exactly what the chart will draw. */}
                <input
                  type="color"
                  aria-label={t('dev.chartColorPicker', { role: t(`dev.chartColor_${role}`) })}
                  value={resolveChartColor(draft[role], role)}
                  onChange={(event) => patch(role, event.target.value)}
                  className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-border-strong bg-surface-input p-1"
                />
                <Input
                  id={`chart-color-${role}`}
                  dir="ltr"
                  spellCheck={false}
                  value={draft[role]}
                  aria-invalid={Boolean(errors[role])}
                  onChange={(event) => patch(role, event.target.value)}
                  className="font-mono text-sm"
                />
                {/* Back to the theme's own colour: the field is emptied, and the
                    store then removes the override entirely. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('dev.chartColorUseSystem', { role: t(`dev.chartColor_${role}`) })}
                  title={t('dev.chartColorUseSystem', { role: t(`dev.chartColor_${role}`) })}
                  disabled={draft[role] === ''}
                  onClick={() => patch(role, '')}
                >
                  <RotateCcw size={16} aria-hidden />
                </Button>
              </div>
            </Field>
          ))}
        </div>

        {/* The unsaved draft, drawn with the same CSS values the charts use, so a
            developer sees the bar colours — not a second, different palette. */}
        <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface-muted/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">{t('dev.chartColorsPreview')}</h3>
            {dirty ? (
              <Badge data-testid="chart-colors-dirty" variant="warning" size="sm" shape="pill" dot>
                {t('dev.unsavedChanges')}
              </Badge>
            ) : null}
          </div>
          <div className="flex h-16 items-end gap-1.5" dir="ltr" aria-hidden>
            {CHART_COLOR_ROLES.map((role, index) => (
              <div
                key={role}
                className="w-8 rounded-t-[3px]"
                style={{
                  height: `${100 - index * 12}%`,
                  background: `var(${CHART_COLOR_VARIABLES[role]})`,
                }}
              />
            ))}
          </div>
          <p className="text-xs text-foreground-subtle">{t('dev.chartColorsPreviewNote')}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setDraft(clone(saved))
              setErrors({})
            }}
          >
            <RotateCcw size={16} aria-hidden />
            {t('dev.resetChanges')}
          </Button>

          <Button
            type="button"
            variant="outline"
            data-testid="chart-colors-load-defaults"
            onClick={() => {
              // Restores the THEME's values at once — the store drops every
              // override, so the bars follow light/dark again.
              resetChartColorSettings()
              setDraft(clone(DEFAULT_CHART_COLORS))
              setErrors({})
            }}
          >
            {t('dev.resetFormatting')}
          </Button>

          <Button type="button" data-testid="chart-colors-save" disabled={!dirty} onClick={save}>
            {t('dev.saveFormatting')}
          </Button>
        </div>
      </div>
    </Card>
  )
}
