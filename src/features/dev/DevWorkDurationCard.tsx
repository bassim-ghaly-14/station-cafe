/**
 * The Dev Settings "Worked-duration display" card.
 *
 * A DISPLAY preference, grouped with the tables and the chart window rather than
 * inside the money/date card, because it is read by the employees surface and
 * has its own Save. The two modes are presented as a radio group: they are
 * mutually exclusive choices between two named presentations, not an open value,
 * so a segmented control states that better than a dropdown.
 *
 * The draft and its Save belong to this card alone: letting it ride along in
 * the money/date draft would mean saving a money setting could silently roll it
 * back.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader } from '@/components/ui'
import { Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import {
  WORK_DURATION_DISPLAY_OPTIONS,
  setWorkDurationSettings,
  useFormattingPreferences,
  type WorkDurationDisplay,
} from '@/lib/formatting'

export function DevWorkDurationCard() {
  const { t } = useTranslation()
  const toast = useToast()

  const saved = useFormattingPreferences()

  const [durationDraft, setDurationDraft] = useState<WorkDurationDisplay>(
    () => saved.workDuration.display,
  )
  const durationDirty = durationDraft !== saved.workDuration.display

  function saveWorkDuration() {
    setWorkDurationSettings({ display: durationDraft })
    toast(t('dev.workDurationSaved'), 'success')
  }

  /** The one translation key that names each mode. */
  const labelKey = (option: WorkDurationDisplay) =>
    option === 'minutes' ? 'dev.workDurationMinutes' : 'dev.workDurationHours'

  return (
    <Card data-testid="dev-work-duration">
      <CardHeader
        title={t('dev.workDurationDisplay')}
        subtitle={t('dev.workDurationDisplayHelp')}
      />

      <div className="flex flex-wrap items-center gap-4">
        <fieldset className="flex flex-wrap items-center gap-4">
          <legend className="sr-only">{t('dev.workDurationDisplay')}</legend>

          {WORK_DURATION_DISPLAY_OPTIONS.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 text-sm text-foreground-muted"
            >
              <input
                type="radio"
                name="work-duration-display"
                value={option}
                checked={durationDraft === option}
                onChange={() => setDurationDraft(option)}
                aria-label={t(labelKey(option))}
                className="size-4 accent-(--color-primary)"
              />
              {t(labelKey(option))}
            </label>
          ))}
        </fieldset>

        <Button disabled={!durationDirty} onClick={saveWorkDuration}>
          <Save size={16} aria-hidden />
          {t('app.save')}
        </Button>
      </div>
    </Card>
  )
}
