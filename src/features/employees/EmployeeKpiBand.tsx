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
 * Layout
 * ------
 * A plain CSS grid runs 1 → 2 → 3 → 5 columns, so the desktop band is a single
 * row of five, a tablet drops to three without shrinking the cards, and a
 * phone stacks them. No card is squeezed into illegibility.
 */
import { useTranslation } from 'react-i18next'
import { Card, KpiGrid, MoneyDisplay, Skeleton } from '@/components/ui'
import { CalendarClock, Clock, Coffee, TrendingUp, Users } from '@/components/ui/icon'
import type { LucideIcon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { EmployeeOverview, Leader } from '@/services/employeesApi'

/** The band's grid is the SHARED KPI rule (`KpiGrid`): one tile per row on a
 * phone, then the same 2 → 3 → 5 progression the desktop already had. The
 * phone step used to be two columns from 360px up, which is what truncated an
 * Arabic label to nothing on a 360px phone.
 */
/** One tile: label, value, and an optional second line of context. */
function KpiTile({
  icon: Icon,
  label,
  children,
  hint,
  className,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly children: React.ReactNode
  readonly hint?: React.ReactNode
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
      <div className="flex flex-col gap-0.5">
        <span className="text-[1.375rem] leading-tight font-bold tabular-nums text-foreground-strong">
          {children}
        </span>
        {hint ? <span className="truncate text-caption text-foreground-subtle">{hint}</span> : null}
      </div>
    </Card>
  )
}

/**
 * The second line of a leader tile: the person's name, or an honest "nobody
 * leads this period" when there is no leader at all.
 */
function LeaderName({ leader }: Readonly<{ readonly leader: Leader | null }>) {
  const { t } = useTranslation()
  if (!leader) return <>{t('employees.kpi.none')}</>
  return <span className="font-medium text-foreground-muted">{leader.name}</span>
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
        hint={t('employees.kpi.totalHint', {
          cashiers: overview.total_cashiers,
          wash: overview.total_wash_workers,
        })}
      >
        <span className="tabular-nums">{overview.total_employees}</span>
      </KpiTile>

      {/* Attendance and hours describe anyone who showed up, so these two tiles
          span BOTH types — a wash worker attends exactly like a cashier does. */}
      <KpiTile
        icon={CalendarClock}
        label={t('employees.kpi.topAttendance')}
        hint={<LeaderName leader={overview.top_attendance} />}
      >
        <span className="tabular-nums">{overview.top_attendance?.value ?? 0}</span>
      </KpiTile>

      <KpiTile
        icon={Clock}
        label={t('employees.kpi.topHours')}
        hint={<LeaderName leader={overview.top_hours} />}
      >
        <span className="tabular-nums">
          {t('employees.kpi.hoursValue', {
            hours: Math.floor(topHours / 60),
            minutes: topHours % 60,
          })}
        </span>
      </KpiTile>

      <KpiTile
        icon={Coffee}
        label={t('employees.kpi.topShifts')}
        hint={<LeaderName leader={overview.top_shifts} />}
      >
        <span className="tabular-nums">{overview.top_shifts?.value ?? 0}</span>
      </KpiTile>

      <KpiTile
        icon={TrendingUp}
        label={t('employees.kpi.topCafeRevenue')}
        hint={<LeaderName leader={overview.top_cafe_revenue} />}
      >
        <MoneyDisplay amount={overview.top_cafe_revenue?.value ?? 0} variant="auto" />
      </KpiTile>
    </KpiGrid>
  )
}
