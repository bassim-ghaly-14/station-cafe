/**
 * The employees KPI band (MANAGER+).
 *
 * Every tile is a real aggregate computed in SQL by the employees overview
 * command — there is no decorative figure and no client-side arithmetic. The
 * leader tiles name a real employee, or state plainly that nobody leads the
 * period: a zero is not a leader, and putting "0" under somebody's name would
 * be a lie.
 *
 * The band is TYPE-AWARE on purpose. Attendance and hours describe anybody who
 * showed up, so those two leaders span every employee. Shifts and cafe revenue
 * describe a CASHIER, and those leaders are computed by the backend over that
 * type only, so a wash worker can never be crowned "top shifts".
 *
 * There is deliberately NO wash-worker leaderboard here. Washing is a shared
 * department: its revenue belongs to the department as a whole, so crowning an
 * individual "top wash revenue" would attribute money that person did not
 * personally produce. The wash department's real revenue is reported at
 * department level in the sales workspace.
 *
 * Hierarchy
 * ---------
 * Each leader tile states the metric LABEL, then the EMPLOYEE NAME, then the
 * figure. The name is the hero: these tiles answer "who led this period", and a
 * reader who lands on the number first has to work backwards to find out whose
 * it was. The figure is supporting evidence, so it sits UNDER the name in the
 * caption size and carries its unit — `23 يوم حضور`, never a bare `23`, which
 * could be read as hours or invoices.
 *
 * Layout
 * ------
 * A plain CSS grid runs 1 → 2 → 3 → 5 columns, so the desktop band is a single
 * row of five, a tablet drops to three without shrinking the cards, and a
 * phone stacks them. No card is squeezed into illegibility.
 */
import { useTranslation } from 'react-i18next'
import {
  Card,
  KpiBreakdown,
  KpiBreakdownEntry,
  KpiGrid,
  MoneyDisplay,
  Skeleton,
} from '@/components/ui'
import { CalendarClock, Clock, Coffee, TrendingUp, Users } from '@/components/ui/icon'
import type { LucideIcon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { EmployeeOverview, Leader } from '@/services/employeesApi'
import { useWorkDurationFormatter } from './attendance'

/** The band's grid is the SHARED KPI rule (`KpiGrid`): one tile per row on a
 * phone, then the same 2 → 3 → 5 progression the desktop already had. The
 * phone step used to be two columns from 360px up, which is what truncated an
 * Arabic label to nothing on a 360px phone.
 */
/** One tile: label, value, and an optional second line of context.
 *
 * A LEADER tile (`leader`) inverts the plain one: the EMPLOYEE NAME is the hero
 * and the figure is the supporting line beneath it. These tiles answer "who led
 * this period, and by how much", so identity is the answer and the number is
 * only the evidence — the same figure at 1.375rem above the name made the
 * number the first thing the eye landed on and the person the caption.
 *
 * Both variants share one card shell, one icon row and one spacing scale, so
 * the headcount tile and the four leader tiles stay visually identical in
 * structure and differ only in what they state.
 */
function KpiTile({
  icon: Icon,
  label,
  children,
  breakdown,
  leader,
  className,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly children: React.ReactNode
  /**
   * An optional block rendered under the figure, separated by a hairline.
   * Used by the headcount tile, whose CASHIER / WASH_WORKER split carries enough
   * information to deserve a real section rather than a caption.
   */
  readonly breakdown?: React.ReactNode
  /**
   * When present, the tile is a LEADER tile: the employee is the hero and
   * `children` becomes the secondary statistic beneath their name. `null` is a
   * real state — nobody leads the period — and renders the honest "nobody"
   * line with NO figure at all, because a zero is not a leader.
   */
  readonly leader?: Leader | null
  readonly className?: string
}) {
  return (
    <Card
      className={cn(
        // Subtle surface contrast and a hairline border instead of a heavy
        // bordered tile: hierarchy comes from spacing and type weight, not from
        // a box around every number.
        'group flex flex-col gap-2 border-border-subtle bg-surface-card p-3.5 transition-colors hover:border-border-strong motion-reduce:transition-none',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary transition-colors group-hover:bg-accent-hover">
          <Icon size={15} aria-hidden />
        </span>
        <p className="min-w-0 truncate text-caption">{label}</p>
      </div>
      {leader === undefined ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-[1.375rem] leading-tight font-bold tabular-nums text-foreground-strong">
            {children}
          </span>
        </div>
      ) : (
        /* Identity first, figure second. `min-w-0` + `truncate` is the SAME
           containment rule the rest of the band uses for a name in a column of
           unknown width: a long Arabic name clips INSIDE its card rather than
           pushing it wider than its grid cell. */
        <div className="flex flex-col gap-1">
          <p className="min-w-0 truncate text-[1.25rem] leading-tight font-bold text-foreground-strong">
            <LeaderName leader={leader} />
          </p>
          {leader ? (
            <p className="min-w-0 truncate text-caption text-foreground-muted">{children}</p>
          ) : null}
        </div>
      )}
      {breakdown ? (
        <div className="mt-auto border-t border-border-subtle pt-2.5">{breakdown}</div>
      ) : null}
    </Card>
  )
}

/**
 * The headcount breakdown: CASHIER vs WASH_WORKER under the total.
 *
 * These are the two employee TYPES, and they are the split that decides who signs
 * in and whose attendance is recorded by a colleague — so the numbers are read at
 * a glance, not decoded from a caption.
 *
 * It renders the SHARED {@link KpiBreakdown} rather than its own `<dl>`: this is
 * the breakdown that established the shape, and the customers order-kinds card
 * states its own total-and-categories the same way. Two bands writing that
 * markup separately is how the spacing, the containment and the figure/label
 * emphasis drift apart.
 */
function HeadcountBreakdown({
  cashiers,
  washWorkers,
}: {
  readonly cashiers: number
  readonly washWorkers: number
}) {
  const { t } = useTranslation()
  return (
    <KpiBreakdown>
      <KpiBreakdownEntry label={t('employees.kpi.cashiers')} value={cashiers} />
      <KpiBreakdownEntry label={t('employees.kpi.washWorkers')} value={washWorkers} />
    </KpiBreakdown>
  )
}

/**
 * The hero line of a leader tile: the person's name, or an honest "nobody leads
 * this period" when there is no leader at all. The weight and size come from the
 * tile, so this states only WHICH of the two it is.
 */
function LeaderName({ leader }: Readonly<{ readonly leader: Leader | null }>) {
  const { t } = useTranslation()
  if (!leader) return <>{t('employees.kpi.none')}</>
  return <>{leader.name}</>
}

export function EmployeeKpiBand({
  overview,
  loading,
  className,
}: {
  readonly overview: EmployeeOverview | null
  readonly loading: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()
  const formatDuration = useWorkDurationFormatter()

  if (loading && !overview) {
    return (
      <KpiGrid
        as="output"
        xl={5}
        className={className}
        aria-busy="true"
        aria-label={t('employees.kpi.loading')}
      >
        {Array.from({ length: 5 }, (_, index) => (
          <Card key={index} className="flex flex-col gap-2 border-border-subtle p-3.5">
            <Skeleton variant="rect" className="size-7" accessibilityLabel="" />
            <div className="flex-1 space-y-2">
              <Skeleton variant="text" className="h-3 w-1/2" accessibilityLabel="" />
              <Skeleton variant="text" className="h-5 w-2/3" accessibilityLabel="" />
            </div>
          </Card>
        ))}
        <span className="sr-only">{t('employees.kpi.loading')}</span>
      </KpiGrid>
    )
  }

  if (!overview) return null

  const topHours = overview.top_hours?.value ?? 0

  return (
    <KpiGrid xl={5} className={className} aria-busy={loading || undefined}>
      <KpiTile
        icon={Users}
        label={t('employees.kpi.total')}
        breakdown={
          <HeadcountBreakdown
            cashiers={overview.total_cashiers}
            washWorkers={overview.total_wash_workers}
          />
        }
      >
        <span className="tabular-nums">{overview.total_employees}</span>
      </KpiTile>

      {/* Attendance and hours describe anyone who showed up, so these two tiles
          span BOTH types — a wash worker attends exactly like a cashier does. */}
      <KpiTile
        icon={CalendarClock}
        label={t('employees.kpi.topAttendance')}
        leader={overview.top_attendance}
      >
        {/* `attendance_days` is already a COUNT OF DAYS (PRESENT days in the
            range), so the figure carries its unit here rather than sitting
            under the name as a bare number of unknown meaning. */}
        <span className="tabular-nums">
          {t('employees.kpi.attendanceDays', { count: overview.top_attendance?.value ?? 0 })}
        </span>
      </KpiTile>

      <KpiTile icon={Clock} label={t('employees.kpi.topHours')} leader={overview.top_hours}>
        {/* The same formatter the table column uses, so the tile and the row
            beneath it can never disagree about how a duration reads — and both
            follow the Dev Settings display mode. */}
        <span className="tabular-nums">{formatDuration(topHours)}</span>
      </KpiTile>

      <KpiTile icon={Coffee} label={t('employees.kpi.topShifts')} leader={overview.top_shifts}>
        <span className="tabular-nums">
          {t('employees.performance.shifts', { count: overview.top_shifts?.value ?? 0 })}
        </span>
      </KpiTile>

      <KpiTile
        icon={TrendingUp}
        label={t('employees.kpi.topCafeRevenue')}
        leader={overview.top_cafe_revenue}
      >
        <MoneyDisplay amount={overview.top_cafe_revenue?.value ?? 0} variant="auto" />
      </KpiTile>
    </KpiGrid>
  )
}
