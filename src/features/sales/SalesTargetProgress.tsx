/**
 * The month's revenue-target progress on the Sales page.
 *
 * One card per department — CAFE and WASH — each answering the same four
 * questions with the backend's own figures: what the target is, what has been
 * earned, what is still missing, and how far along that is. The day-by-day
 * section underneath shows the same month broken into days, with each day's
 * CUMULATIVE achievement against the FULL monthly target.
 *
 * Three things this component deliberately does not do:
 *
 *  - it does not compute revenue, a remainder or a percentage. Those arrive from
 *    `sales_target_progress`, which resolves the target and aggregates the
 *    invoice snapshot exactly as the rest of the Sales page does;
 *  - it does not invent a "daily target". The owner configured one number for
 *    the month, so each day answers "how much of THAT has been earned so far";
 *  - it does not clamp the business value. A month at 114% prints 114%, and
 *    only the BAR is capped, because a bar that overruns its track stops being
 *    readable while the number beside it stays true.
 *
 * A month with NO target says so plainly, instead of showing `0%` (which would
 * claim nothing was achieved) or any invented figure.
 */
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Card,
  DataTable,
  DataTableCell,
  DataTableRow,
  DisplayDate,
  MoneyDisplay,
  type DataTableColumn,
} from '@/components/ui'
import { Coffee, Droplets } from '@/components/ui/icon'
import { chartBarColor } from '@/lib/chart-colors'
import { formatMonthKey } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { DepartmentTargetProgress, MonthlyTargetProgress } from '@/services/salesApi'
import { achievementText, departmentDays } from './targetProgress'

export function SalesTargetProgress({
  progress,
  className,
}: {
  readonly progress: MonthlyTargetProgress
  readonly className?: string
}) {
  const { t, i18n } = useTranslation()
  // The month the BACKEND resolved, labelled in the active locale. The key stays
  // the canonical `YYYY-MM`; only the display is translated.
  const month = formatMonthKey(progress.month, i18n.language)

  return (
    <section
      className={cn('flex flex-col gap-3', className)}
      aria-label={t('sales.targets.title')}
      data-testid="sales-targets"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-section text-foreground-strong">{t('sales.targets.title')}</h2>
        <p className="text-caption text-foreground-subtle">{month}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DepartmentTargetCard
          progress={progress.cafe}
          label={t('catalog.CAFE')}
          testId="sales-target-cafe"
        />
        <DepartmentTargetCard
          progress={progress.wash}
          label={t('catalog.WASH')}
          testId="sales-target-wash"
        />
      </div>

      {progress.daily.length > 0 ? (
        <DailyTargetTable progress={progress} />
      ) : (
        <Card>
          <p className="text-caption text-foreground-subtle">{t('sales.targets.daily.empty')}</p>
        </Card>
      )}
    </section>
  )
  /** One department: target, achieved, remaining, and the achievement itself. */
  function DepartmentTargetCard({
    progress,
    label,
    testId,
  }: {
    readonly progress: DepartmentTargetProgress
    readonly label: string
    readonly testId: string
  }) {
    const { t } = useTranslation()
    const isCafe = progress.department === 'CAFE'
    const Icon = isCafe ? Coffee : Droplets
    // The SAME chart role the monthly Cafe-vs-Wash chart gives this department, so
    // the target card and the monthly chart cannot imply different colours for one
    // business line.
    const accent = chartBarColor(isCafe ? 'secondary' : 'primary')
    const percent = achievementText(progress.achievement_percent)
    // The bar's width, capped: only the DRAWING is capped, never the figure.
    const fill = percent === null ? 0 : Math.min(100, Number(percent))

    return (
      <Card className="flex flex-col gap-3 p-4" data-testid={testId}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-caption">
            <Icon size={15} aria-hidden className="text-primary" />
            {label}
          </p>
          {/* Stated, not inferred: an overridden month is visibly a DIFFERENT
            number from the cafe-wide default, which is the point of an override. */}
          {progress.overridden ? (
            <Badge variant="info" size="sm">
              {t('sales.targets.overriddenBadge')}
            </Badge>
          ) : (
            <Badge variant="neutral" size="sm">
              {t('sales.targets.defaultBadge')}
            </Badge>
          )}
        </div>

        <p
          className="text-3xl leading-tight font-extrabold text-foreground-strong"
          data-testid={`${testId}-percent`}
        >
          {/* A month with no target has no percentage to print; the dash is the
            shared "not applicable" mark, never a fabricated zero. */}
          {percent === null ? (
            <span className="text-foreground-subtle" title={t('sales.targets.noTarget')}>
              —
            </span>
          ) : (
            <>
              {percent}
              <span className="text-lg">%</span>
            </>
          )}
        </p>

        <div
          className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-label={t('sales.targets.achievement')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fill}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${fill}%`, backgroundColor: accent }}
          />
        </div>

        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Figure label={t('sales.targets.target')} amount={progress.target_minor} />
          <Figure label={t('sales.targets.actual')} amount={progress.actual_minor} />
          <Figure label={t('sales.targets.remaining')} amount={progress.remaining_minor} />
        </dl>
      </Card>
    )
  }

  /** One labelled money figure. */
  function Figure({ label, amount }: { readonly label: string; readonly amount: number }) {
    return (
      <div className="flex flex-col">
        <dt className="text-caption">{label}</dt>
        <dd className="text-base font-bold text-foreground-strong">
          <MoneyDisplay amount={amount} variant="auto" />
        </dd>
      </div>
    )
  }
  /**
   * The month day by day.
   *
   * One table, not two: the two departments move together through the month, and a
   * reader comparing a strong cafe day against a quiet wash day reads far better
   * from one list than from two parallel tables.
   */
  function DailyTargetTable({ progress }: { readonly progress: MonthlyTargetProgress }) {
    const { t } = useTranslation()
    const cafeDays = departmentDays(progress.daily, 'CAFE')
    const washDays = departmentDays(progress.daily, 'WASH')

    const columns: DataTableColumn[] = [
      { key: 'date', label: t('sales.targets.daily.date'), headerClassName: 'w-32' },
      {
        key: 'cafe',
        label: t('sales.targets.daily.cafeColumn'),
        cellClassName: 'text-end',
      },
      {
        key: 'cafeProgress',
        label: t('sales.targets.daily.cafeProgressColumn'),
        hideBelow: 'sm',
        cellClassName: 'text-end',
      },
      {
        key: 'wash',
        label: t('sales.targets.daily.washColumn'),
        cellClassName: 'text-end',
      },
      {
        key: 'washProgress',
        label: t('sales.targets.daily.washProgressColumn'),
        hideBelow: 'sm',
        cellClassName: 'text-end',
      },
    ]

    return (
      <Card className="overflow-hidden p-0">
        <div className="border-b border-border-subtle px-4 py-3">
          <h3 className="text-section text-foreground-strong">{t('sales.targets.daily.title')}</h3>
          <p className="mt-0.5 text-caption text-foreground-subtle">
            {t('sales.targets.daily.hint')}
          </p>
        </div>

        <DataTable caption={t('sales.targets.daily.caption')} columns={columns}>
          {cafeDays.map((day, index) => {
            const wash = washDays[index]
            return (
              <DataTableRow key={day.dayDate}>
                <DataTableCell>
                  <DisplayDate value={day.dayDate} />
                </DataTableCell>
                <DataTableCell className="text-end">
                  <MoneyDisplay amount={day.revenue} variant="auto" />
                </DataTableCell>
                <DataTableCell className="text-end hidden sm:table-cell">
                  <DayAchievement percent={day.achievementPercent} />
                </DataTableCell>
                <DataTableCell className="text-end">
                  <MoneyDisplay amount={wash.revenue} variant="auto" />
                </DataTableCell>
                <DataTableCell className="text-end hidden sm:table-cell">
                  <DayAchievement percent={wash.achievementPercent} />
                </DataTableCell>
              </DataTableRow>
            )
          })}
        </DataTable>
      </Card>
    )
  }

  /** One day's cumulative achievement, or the "no target" dash. */
  function DayAchievement({ percent }: { readonly percent: string | null }) {
    if (percent === null) {
      return <span className="text-foreground-subtle">—</span>
    }
    return <span className="font-bold text-foreground-strong tabular-nums">{percent}%</span>
  }
}
