/**
 * The one-page A4 executive sheet.
 *
 * ONE component serves both jobs it has: the on-screen preview inside the tab
 * and the printed page. They are the same markup on purpose — a preview that
 * differs from the print output is a preview of something the owner never gets.
 *
 * # Why the WebView's own print pipeline, and not a PDF library
 *
 * Station's `printing/` module is ESC/POS for an 80 mm thermal roll: it cannot
 * produce A4, and a management document is not a receipt. Adding a PDF library
 * would mean shipping and shaping an Arabic font into it, because those
 * libraries draw glyphs themselves and do not shape or bidi-order Arabic. The
 * browser already has all of that — the bundled `Cairo` font, the app's RTL
 * direction and the Station colour tokens — so `window.print()` with an
 * `@page { size: A4 }` rule (see `index.css`) renders real A4 pages, in Arabic,
 * from the very tokens the rest of the application uses. That is an EXTENSION of
 * existing infrastructure, not a parallel mechanism, and it adds no dependency.
 *
 * # Why it is exactly one page
 *
 * The sheet is a fixed A4 box that cannot exceed the printable area, and the
 * `@media print` rules in `index.css` drop every margin, shadow and border that
 * does not survive paper. Nothing here grows with the data: the content is four
 * sections and at most three notes, whatever the month contains.
 */
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/Logo'
import { MoneyDisplay } from '@/components/ui'
import { formatMonthKey } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { MonthlyExecutiveReport } from '@/services/opsApi'
import { keyNotes, moneyMovement, type MoneyMovement } from './monthlyExecutive'

/** The largest achievement the bar draws; past it the bar is simply full. */
const FULL_SCALE = 100

/**
 * ONE column template, shared by Money and Movement.
 *
 * Both sections must break at exactly the same two points so the report reads as
 * a single aligned table rather than two rows that happen to sit near each other.
 * Declaring the template once is what guarantees that: neither section can be
 * narrower than the other, because neither computes its own widths.
 *
 * `grid-cols-3` (not flex) is the point of it — three flex children size to their
 * CONTENT, so the widest figure would take a wider share than its neighbours and
 * the row would never fill the page. Grid columns are equal by definition and
 * always consume the full content width.
 */
const THREE_COLUMNS = 'grid grid-cols-3 gap-2 print:gap-0'

/**
 * Actual against target, as one bar.
 *
 * It exists to make ONE relationship legible — how far the actual reached the
 * target — and it adds no figure: the same `achievement_percent` is printed
 * beside it as text, so the bar is a reading aid and never the only source.
 * A department with no target has nothing to be a percentage OF, so it gets the
 * same shared dash as everywhere else rather than an empty track.
 */
function AchievementBar({ percent }: Readonly<{ percent: string | null }>) {
  const value = percent === null ? null : Number(percent)
  const filled = value === null ? 0 : Math.min(Math.max(value, 0), FULL_SCALE)
  return (
    <div
      aria-hidden
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted print:bg-black/10"
    >
      <div
        className="h-full rounded-full bg-primary print:bg-black/70"
        style={{ width: `${filled}%` }}
      />
    </div>
  )
}

/**
 * One Money figure, as a cell of the shared three-column row.
 *
 * The border is what makes the three read as three cards rather than as three
 * loose numbers; `min-w-0` keeps a long amount inside its own third instead of
 * pushing the row wider than the page, and the shared `gap` on the parent is
 * what spaces them evenly.
 */
function MoneyCell({ label, amount }: Readonly<{ label: string; amount: number }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border-subtle bg-surface-muted/40 p-3 print:border-black/20 print:bg-transparent">
      <dt className="text-caption">{label}</dt>
      <dd className="text-money">
        <MoneyDisplay amount={amount} />
      </dd>
    </div>
  )
}

/** One department: what it earned, what it was aimed at, and how far along. */
function DepartmentBlock({
  label,
  performance,
  testId,
}: Readonly<{
  label: string
  performance: MonthlyExecutiveReport['cafe']
  testId: string
}>) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2" data-testid={testId}>
      <h3 className="text-section">{label}</h3>
      <div className="flex flex-col">
        <span className="text-caption">{t('reports.monthly.actual')}</span>
        {/* The actual is the number the section exists to state, so it is the
            one figure on the page set larger than the shared money size. */}
        <span className="text-lg leading-tight font-bold text-foreground-strong tabular-nums">
          <MoneyDisplay amount={performance.actual_minor} />
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-caption">{t('reports.monthly.target')}</span>
        <span className="text-body tabular-nums text-foreground-muted">
          <MoneyDisplay amount={performance.target_minor} />
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <AchievementBar percent={performance.achievement_percent} />
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-caption">{t('reports.monthly.achievement')}</span>
          <span className="text-money">
            {/* No target is the shared dash everywhere in Station, never `0%`. */}
            {performance.achievement_percent === null ? (
              <span className="text-foreground-subtle">—</span>
            ) : (
              <span dir="ltr">{performance.achievement_percent}%</span>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * One movement figure: a signed percentage, or the dash when the month before had
 * nothing to compare against. Never `NaN`, never `Infinity`.
 *
 * The tone is decided from the NUMERIC percent — never from the formatted string —
 * and reuses the application's existing semantic tokens (`text-success` /
 * `text-destructive`, as in `MonthlyComparisonBarChart` and the inventory movement
 * log), so light/dark themes stay the theme's decision. Zero keeps the existing
 * neutral/muted styling and is never treated as positive or negative.
 */
function Movement({ label, movement }: Readonly<{ label: string; movement: MoneyMovement }>) {
  const { t } = useTranslation()
  if (movement.percent === null) {
    return (
      <div className="flex flex-col">
        <span className="text-caption">{label}</span>
        <span className="text-money text-foreground-subtle">—</span>
      </div>
    )
  }
  const arrow = movement.trend === 'up' ? '↑' : movement.trend === 'down' ? '↓' : '→'
  const tone =
    movement.percent > 0
      ? 'text-success'
      : movement.percent < 0
        ? 'text-destructive'
        : 'text-foreground-muted'
  return (
    <div className="flex flex-col">
      <span className="text-caption">{label}</span>
      {/* `dir="ltr"` keeps the arrow attached to its number inside the RTL line. */}
      {/* A single tone on this span colours the number AND the arrow together. */}
      {/* `print:text-black` keeps paper readable from either theme, as the sheet's
          own print rules re-bind foregrounds to black ink. */}
      <span className={cn('text-money print:text-black', tone)} dir="ltr">
        {arrow} {t('reports.monthly.percentValue', { value: movement.percent })}
      </span>
    </div>
  )
}

export function MonthlyReportDocument({
  report,
  className,
}: Readonly<{ report: MonthlyExecutiveReport; className?: string }>) {
  const { t, i18n } = useTranslation()
  const movement = moneyMovement(report.money, report.previous)
  const notes = keyNotes(report)

  return (
    <article
      dir="rtl"
      data-testid="monthly-report-document"
      className={cn(
        // On screen the sheet is a themed surface, so it follows light and dark
        // like the rest of the application. The `print:` variants are what make
        // it PAPER: white ground, black ink and black rules, so the same markup
        // is a dark-mode card on screen and a printable document on paper.
        'flex flex-col gap-5 rounded-lg border border-border bg-surface-card p-6 text-foreground',
        // `print:max-w-none` is the clipping fix, and it is load-bearing. The
        // screen width cap is 48rem (768px = 203mm), which is WIDER than the A4
        // printable content box (182mm). Left in force while printing, the sheet
        // overflowed its container and — in RTL — the excess was cut off on the
        // left by the container's `overflow: hidden`.
        'print:max-w-none print:rounded-none print:border-0 print:bg-white print:text-black',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3 print:border-black/15">
        <div className="flex items-center gap-2">
          <Logo size={44} />
          <div className="flex flex-col">
            <h1 className="text-heading">{t('reports.monthly.brand')}</h1>
            <p className="text-caption">
              {t('reports.monthly.subtitle', {
                month: formatMonthKey(report.month, i18n.language),
              })}
            </p>
          </div>
        </div>
        <p className="text-caption">{t('reports.monthly.generated')}</p>
      </header>

      <section className="flex flex-col gap-3" aria-labelledby="monthly-performance-heading">
        <h2 id="monthly-performance-heading" className="text-section">
          {t('reports.monthly.performance')}
        </h2>
        {/* Cafe and Wash side by side and never merged: two independent targets
            cannot honestly be added into one achievement. The rule between them
            is a divider, not a gap, so the two columns read as one comparison. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-0">
          <DepartmentBlock
            label={t('catalog.CAFE')}
            performance={report.cafe}
            testId="monthly-report-cafe"
          />
          <div
            aria-hidden
            className="hidden w-px shrink-0 bg-border-subtle sm:mx-6 sm:block print:bg-black/15"
          />
          <DepartmentBlock
            label={t('catalog.WASH')}
            performance={report.wash}
            testId="monthly-report-wash"
          />
        </div>
      </section>

      <section
        className="flex flex-col gap-3 border-t border-border-subtle pt-4 print:border-black/15"
        aria-labelledby="monthly-money-heading"
      >
        <h2 id="monthly-money-heading" className="text-section">
          {t('reports.monthly.money')}
        </h2>
        {/* Three equal cells on the SHARED template, each a bordered box. Grid
            stretches its rows by default, so the three are equal in width AND in
            height without either being measured. */}
        <dl className={THREE_COLUMNS}>
          <MoneyCell label={t('reports.monthly.revenue')} amount={report.money.revenue_minor} />
          <MoneyCell label={t('reports.monthly.expenses')} amount={report.money.expenses_minor} />
          <MoneyCell label={t('reports.monthly.net')} amount={report.money.net_minor} />
        </dl>
      </section>

      <section
        className="flex flex-col gap-3 border-t border-border-subtle pt-4 print:border-black/15"
        aria-labelledby="monthly-movement-heading"
      >
        <h2 id="monthly-movement-heading" className="text-section">
          {t('reports.monthly.movement')}
        </h2>
        <p className="text-caption">
          {t('reports.monthly.vsPrevious', {
            month: formatMonthKey(report.previous_month, i18n.language),
          })}
        </p>
        {/* Percentages only. The previous month's AMOUNTS are deliberately not
            printed: they are history the reports already show, and a second table
            of them would turn a one-minute summary into a second report. */}
        <div className={THREE_COLUMNS}>
          <Movement label={t('reports.monthly.revenue')} movement={movement.revenue} />
          <Movement label={t('reports.monthly.expenses')} movement={movement.expenses} />
          <Movement label={t('reports.monthly.net')} movement={movement.net} />
        </div>
      </section>

      <section
        className="flex flex-col gap-2 border-t border-border-subtle pt-4 print:border-black/15"
        aria-labelledby="monthly-notes-heading"
      >
        <h2 id="monthly-notes-heading" className="text-section">
          {t('reports.monthly.keyNotes')}
        </h2>
        <ul className="flex list-disc flex-col gap-1 ps-5 text-foreground-muted">
          {notes.map((note) => (
            <li key={note.key} className="text-body">
              {/* A note names its department in the active language; the slug the
                  model carries is never printed. */}
              {t(note.key, {
                ...note.values,
                // The movement's direction is a SLUG resolved here, so an Arabic
                // sentence never carries an English word.
                direction: t(`reports.monthly.trend.${note.trend ?? 'flat'}`),
                // A note names its department in the active language; the slug
                // the model carries is never printed.
                department:
                  note.key === 'reports.monthly.notes.cafeTarget'
                    ? t('catalog.CAFE')
                    : t('catalog.WASH'),
              })}
            </li>
          ))}
        </ul>
      </section>
    </article>
  )
}
