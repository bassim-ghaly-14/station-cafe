import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, Inbox, TrendingUp } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

/**
 * ChartEmptyState — the "nothing to plot" state for the analytics area.
 *
 * Design intent: an empty chart is a *chart*, not a message box. The state
 * therefore renders a real plot frame — axis, gridlines, tick marks and a
 * dashed, value-less trend path — so the screen still reads as an analytics
 * surface and the user can see exactly what will appear once data exists.
 *
 * Data integrity: the motif is purely decorative. It is `aria-hidden`, it is
 * drawn with dashes and hollow markers rather than filled marks, and it
 * encodes no axis labels, scale, totals or percentages. It can never be read
 * as a measurement. Nothing here is fabricated business data.
 *
 * It answers three questions in order of importance:
 *   1. there is nothing to visualise (title),
 *   2. what will populate it (body),
 *   3. why it might be empty and what to do about it (hints + optional action).
 */
export function ChartEmptyState({
  className,
  title,
  body,
  hint,
  action,
  scope,
  compact = false,
  headingLevel: Heading = 'h2',
}: {
  className?: string
  /** Overrides the shared headline; used by the per-chart variant. */
  title?: string
  /** Overrides the shared explanation; used by the per-chart variant. */
  body?: string
  /** Rendered as a restrained "why this can happen" note. */
  hint?: string
  /** Only pass a real, working control — never a decorative button. */
  action?: ReactNode
  /** Context line describing the scope that came back empty (e.g. the period). */
  scope?: string
  /** The in-card variant: smaller frame, no reason list. */
  compact?: boolean
  /**
   * Heading element for the state title. The in-card variant sits inside a card
   * that already owns an `h2`, so it must step down to keep the document
   * outline correct for screen readers.
   */
  headingLevel?: 'h2' | 'h3'
}) {
  const { t } = useTranslation()

  return (
    <section
      className={cn(
        'flex flex-col items-center rounded-lg border border-border-subtle bg-surface-card text-center',
        compact ? 'gap-3 px-4 py-6' : 'gap-5 px-5 py-10 sm:px-8 sm:py-12',
        className,
      )}
    >
      <ChartFrame compact={compact} />

      <div className={cn('flex max-w-xl flex-col gap-1.5', compact ? 'px-1' : 'px-2')}>
        {scope ? <p className="text-caption text-foreground-subtle tabular-nums">{scope}</p> : null}
        <Heading
          className={cn(
            'text-balance font-bold text-foreground-strong',
            compact ? 'text-base' : 'text-lg',
          )}
        >
          {title ?? t('reports.charts.emptyTitle')}
        </Heading>
        <p className="text-pretty text-sm leading-relaxed text-foreground-muted">
          {body ?? t('reports.charts.emptyBody')}
        </p>
      </div>

      {hint && !compact ? (
        <p className="max-w-xl px-2 text-pretty text-xs leading-relaxed text-foreground-subtle">
          {hint}
        </p>
      ) : null}

      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </section>
  )
}

/**
 * The decorative plot frame.
 *
 * Drawn once as an inline SVG so it inherits the theme tokens and scales to any
 * card width. Geometry only: an axis corner, four gridlines, five x-axis ticks
 * and a dashed, marker-less path over a soft, value-less wash. It is
 * `preserveAspectRatio`-free so it fills the width without distorting, and it
 * is `dir="ltr"` internally because plot geometry is direction-agnostic.
 */
function ChartFrame({ compact }: { compact: boolean }) {
  const markers = [
    [34, 118],
    [98, 96],
    [162, 104],
    [226, 70],
    [290, 52],
  ] as const
  const gridlines = [28, 60, 92, 124] as const
  const ticks = [34, 98, 162, 226, 290] as const

  return (
    <div aria-hidden dir="ltr" className={cn('w-full', compact ? 'max-w-56' : 'max-w-80')}>
      <svg viewBox="0 0 320 160" className="h-auto w-full" role="presentation" focusable="false">
        <defs>
          <linearGradient id="station-chart-motif" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-motif-strong)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--chart-motif-strong)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridlines.map((y) => (
          <line key={y} x1="34" x2="306" y1={y} y2={y} stroke="var(--chart-grid)" strokeWidth="1" />
        ))}

        <path
          d="M34 14 V140 H306"
          fill="none"
          stroke="var(--chart-frame)"
          strokeWidth="1.25"
          strokeLinecap="round"
        />

        {ticks.map((x) => (
          <line
            key={x}
            x1={x}
            x2={x}
            y1="140"
            y2="146"
            stroke="var(--chart-frame)"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        ))}

        {/* The wash carries no scale and the path is dashed and unfilled, so
            neither can be read as a value. */}
        <path
          d="M34 118 L98 96 L162 104 L226 70 L290 52 L290 140 L34 140 Z"
          fill="url(#station-chart-motif)"
        />
        <path
          d="M34 118 L98 96 L162 104 L226 70 L290 52"
          fill="none"
          stroke="var(--chart-frame)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray="5 5"
        />

        {markers.map(([cx, cy]) => (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r="3"
            fill="var(--surface-card)"
            stroke="var(--chart-frame)"
            strokeWidth="1.5"
          />
        ))}
      </svg>
    </div>
  )
}

/**
 * The "why is it empty" list: the three real reasons an analytics report comes
 * back with nothing, in the order a manager would actually check them. Shown
 * only on the full-page variant, where there is room to be genuinely helpful.
 */
export function ChartEmptyReasons() {
  const { t } = useTranslation()
  const reasons = [
    { key: 'reports.charts.emptyReasonPeriod', icon: CalendarDays },
    { key: 'reports.charts.emptyReasonActivity', icon: TrendingUp },
    { key: 'reports.charts.emptyReasonScope', icon: Inbox },
  ] as const
  return (
    <ul className="mx-auto flex w-full max-w-xl flex-col gap-2 px-2">
      {reasons.map(({ key, icon: Icon }) => (
        <li key={key} className="flex items-start gap-2 text-start text-xs text-foreground-subtle">
          <Icon size={14} aria-hidden className="mt-0.5 shrink-0" />
          <span className="text-pretty leading-relaxed">{t(key)}</span>
        </li>
      ))}
    </ul>
  )
}
