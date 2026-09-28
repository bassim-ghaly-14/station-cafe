/**
 * The Dev Settings "Formatting Preview Lab".
 *
 * Everything here renders from the UNSAVED DRAFT, so a change is visible before
 * it is committed. It is deliberately exhaustive: every configurable option has
 * at least one row whose output changes when that option changes, including the
 * compact-threshold BOUNDARY (values straddling the threshold) rather than a
 * static number.
 *
 * All values pass through the same central formatters the application uses —
 * only the settings object differs, so the preview cannot drift from reality.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@/lib/date'
import { formatMoney } from '@/lib/money'
import { DisplayDateTime } from '@/components/ui/display-datetime'
import { cn } from '@/lib/utils'
import type { FormattingPreferences } from '@/lib/formatting'

/** Deterministic examples — never "now", so the preview is stable. */
const STANDARD = 1250
const LARGE = 1_250_000
const DECIMAL = 1250.5
const NEGATIVE = -1250

/** Fixed instants used for every date/time example. */
const STAMP = '2026-09-25T14:35:27'
const MORNING_STAMP = '2026-09-25T09:56:00'
const DATE_ONLY = '2026-09-25'

/** One labelled line. The value is bidi-isolated, so it is never reordered. */
function Row({
  label,
  children,
  note,
  testId,
}: {
  readonly label: string
  readonly children: ReactNode
  readonly note?: string
  readonly testId?: string
}) {
  return (
    <div
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border-subtle py-1.5 last:border-b-0"
      data-testid={testId}
    >
      <span className="text-xs text-foreground-muted">{label}</span>
      <span
        dir="ltr"
        style={{ direction: 'ltr', unicodeBidi: 'isolate' }}
        className="min-w-0 max-w-full text-end text-sm font-bold tabular-nums wrap-anywhere"
      >
        {children}
      </span>
      {note ? <span className="w-full text-xs text-foreground-faint">{note}</span> : null}
    </div>
  )
}

function Section({ title, children }: Readonly<{ readonly title: string; children: ReactNode }>) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1 text-sm font-bold text-foreground-strong">{title}</h4>
      <div className="min-w-0 rounded-md border border-border-subtle bg-surface px-3 py-1">
        {children}
      </div>
    </section>
  )
}

export function FormattingPreview({ draft }: Readonly<{ readonly draft: FormattingPreferences }>) {
  const { t } = useTranslation()
  const money = { settings: draft.money }
  const dateOptions = { settings: draft.date }

  // The boundary trio proves the threshold setting actually gates the switch:
  // raising the threshold moves the boundary and visibly flips these rows.
  const threshold = draft.money.compactThreshold

  return (
    <div
      data-testid="formatting-preview"
      className="flex min-w-0 flex-col gap-4 rounded-md border border-border-strong bg-surface-muted p-4"
    >
      <p className="text-caption">{t('dev.previewDescription')}</p>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Section title={t('dev.previewMoney')}>
          <Row label={t('dev.previewStandard')} testId="preview-standard">
            {formatMoney(STANDARD, money)}
          </Row>
          <Row label={t('dev.previewLarge')} testId="preview-large">
            {formatMoney(LARGE, money)}
          </Row>
          <Row label={t('dev.previewDecimal')} testId="preview-decimal">
            {formatMoney(DECIMAL, money)}
          </Row>
          <Row label={t('dev.previewNegative')} testId="preview-negative">
            {formatMoney(NEGATIVE, money)}
          </Row>
          <Row label={t('dev.previewZero')} testId="preview-zero">
            {formatMoney(0, money)}
          </Row>
          <Row label={t('dev.previewAuto')} note={t('dev.previewAutoNote')} testId="preview-auto">
            {formatMoney(LARGE, { ...money, variant: 'auto' })}
          </Row>
        </Section>

        <Section title={t('dev.previewThreshold')}>
          <p className="py-1 text-xs text-foreground-faint">{t('dev.previewThresholdNote')}</p>
          <Row label={t('dev.previewBelow', { value: threshold - 1 })} testId="preview-below">
            {formatMoney(threshold - 1, { ...money, variant: 'auto' })}
          </Row>
          <Row label={t('dev.previewAt', { value: threshold })} testId="preview-at">
            {formatMoney(threshold, { ...money, variant: 'auto' })}
          </Row>
          <Row label={t('dev.previewAbove', { value: threshold + 1 })} testId="preview-above">
            {formatMoney(threshold + 1, { ...money, variant: 'auto' })}
          </Row>
        </Section>

        <Section title={t('dev.previewDateTime')}>
          <Row label={t('dev.previewDate')} testId="preview-date">
            {formatDate(DATE_ONLY, dateOptions)}
          </Row>
          <Row label={t('dev.previewDateLong')} testId="preview-date-2">
            {formatDate('2026-12-01', dateOptions)}
          </Row>
          <Row label={t('dev.previewTime')} testId="preview-time">
            {formatTime(STAMP, dateOptions)}
          </Row>
          <Row label={t('dev.previewTimeMorning')} testId="preview-time-2">
            {formatTime(MORNING_STAMP, dateOptions)}
          </Row>
          {/* The COMBINED result, laid out exactly like a shift card. A long
              localized date must not overlap the time or the separator. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border-subtle py-1.5 last:border-b-0">
            <span className="text-xs text-foreground-muted">{t('dev.previewCombined')}</span>
            <DisplayDateTime value={STAMP} options={dateOptions} className="text-sm" />
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5">
            <span className="text-xs text-foreground-muted">{t('dev.previewCard')}</span>
            <span
              className={cn(
                'flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border-subtle',
                'px-2 py-1 text-sm font-bold text-foreground-strong',
              )}
            >
              <DisplayDateTime value={MORNING_STAMP} options={dateOptions} />
            </span>
          </div>
        </Section>

        <Section title={t('dev.previewActive')}>
          <Row label={t('dev.previewDateFormat')}>
            <code className="text-xs">{draft.date.dateFormat}</code>
          </Row>
          <Row label={t('dev.previewTimeFormat')}>
            <code className="text-xs">
              {draft.date.timeFormat === '12h' ? '12h' : '24h'}
              {draft.date.showSeconds ? ' + s' : ''}
            </code>
          </Row>
          <Row label={t('dev.previewDecimals')}>
            <code className="text-xs">{draft.money.decimalPlaces}</code>
          </Row>
          <Row label={t('dev.previewSeparator')}>
            <code className="text-xs">{draft.money.useThousandsSeparator ? '1,000' : '1000'}</code>
          </Row>
          <Row label={t('dev.previewCurrency')}>
            <code className="text-xs">
              {!draft.money.showCurrency
                ? 'OFF'
                : draft.money.currencyPosition === 'before'
                  ? 'BEFORE'
                  : 'AFTER'}
            </code>
          </Row>
          <Row label={t('dev.previewCompact')}>
            <code className="text-xs">
              {draft.money.compactLargeValues ? `AUTO >= ${threshold}` : 'FULL'}
            </code>
          </Row>
        </Section>
      </div>
    </div>
  )
}
