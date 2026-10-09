/**
 * The monthly executive report's PRESENTATION model — movement percentages and
 * the factual notes printed under the figures.
 *
 * This is the whole of the report layer's own logic, and it is deliberately
 * arithmetic-free of business meaning: every revenue, expense and target figure
 * it reads arrives already calculated by the backend from the existing monthly
 * aggregation, the existing expense period total and the existing target
 * resolver. Nothing here re-derives a month, re-resolves a target or re-aggregates
 * money — a report that computed its own figures is how a screen and a report
 * start disagreeing about the same month.
 *
 * It is a separate module from the sheet that renders it so these rules can be
 * tested directly, without a DOM.
 */
import type { MonthlyComparisonMode, MonthlyExecutiveReport, MonthlyMoney } from '@/services/opsApi'

/**
 * The two comparison periods, as the slugs the note sentences interpolate.
 *
 * A movement note says what it moved AGAINST, so the mode has to reach the
 * sentence. It travels as a slug — like `direction` and `department` already do
 * — and is resolved to a word in the active language where it is rendered, so no
 * English ever sits inside an Arabic sentence and the i18n audit can see it.
 */
const COMPARISON_PERIOD: Record<MonthlyComparisonMode, string> = {
  PREVIOUS_MONTH: 'previousMonth',
  SAME_MONTH_PREVIOUS_YEAR: 'sameMonthPreviousYear',
}

/**
 * How one month's money moved against the month before it.
 *
 * Presentation only. `percent` is `null` — printed as the shared "no comparison"
 * dash — whenever the previous month is zero, which is the SAME degenerate case
 * `monthOverMonth` in `components/charts/monthlyComparison.ts` already handles
 * for the monthly comparison charts. That is deliberate: "growth from nothing"
 * has no percentage, and `Infinity`/`NaN` must never reach a printed page.
 */
export interface MoneyMovement {
  trend: 'up' | 'down' | 'flat' | 'unavailable'
  /** Percentage change, one decimal, or `null` when it cannot be computed. */
  percent: number | null
}

/**
 * Percentage change of `current` against `previous`, in hundredths of a percent
 * so the arithmetic stays integral and exactly reproducible, then stated to ONE
 * decimal — the precision a manager reads at a glance.
 *
 * The three degenerate cases are explicit rather than numeric accidents, exactly
 * as in `monthOverMonth`: no previous month, a previous month of zero, and no
 * change at all each mean something different and none of them is a division.
 */
export function monthOverMonth(current: number, previous: number | null): MoneyMovement {
  if (previous === null || previous === 0) {
    return { trend: 'unavailable', percent: null }
  }
  const hundredths = ((current - previous) * 10_000) / previous
  const percent = Math.round(hundredths / 10) / 10
  const trend = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat'
  return { trend, percent }
}

/**
 * The movement of all three money figures at once.
 *
 * Only percentages cross this boundary: the previous month's amounts stay in the
 * payload and are deliberately NOT rendered, so the page cannot grow into a
 * two-month table that duplicates history the reports already show.
 */
export function moneyMovement(
  money: MonthlyMoney,
  previous: MonthlyMoney,
): Record<'revenue' | 'expenses' | 'net', MoneyMovement> {
  return {
    revenue: monthOverMonth(money.revenue_minor, previous.revenue_minor),
    expenses: monthOverMonth(money.expenses_minor, previous.expenses_minor),
    net: monthOverMonth(money.net_minor, previous.net_minor),
  }
}

/**
 * One factual note about the month, ready to render.
 *
 * `key` is an i18next key and `values` its parameters — a note is never a
 * pre-built string, so the same facts print in whatever language is active and
 * the i18n audit can see every one of them. `trend` is a movement SLUG, resolved
 * to a word by the document through `reports.monthly.trend.*`; no English is
 * ever carried into an Arabic sentence.
 */
export interface ExecutiveNote {
  key: string
  values: Record<string, string>
  /** Present only on a movement note, and translated where it is rendered. */
  trend?: MoneyMovement['trend']
}

/** How many notes the page may ever print. */
export const MAX_KEY_NOTES = 3

/**
 * The two or three facts worth stating under the figures.
 *
 * Every note is a DETERMINISTIC restatement of a number printed directly above
 * it — nothing is generated, ranked by sentiment or judged. There is deliberately
 * no vocabulary for "excellent", "weak" or "needs improvement": Station reports
 * facts about a business and does not grade it.
 *
 * The order is fixed (cafe target, wash target, then the largest money movement)
 * so the same month always produces the same notes. A department with no target
 * contributes nothing rather than a fabricated `0%`, and a movement with no
 * previous month to compare against is simply absent.
 */
export function keyNotes(report: MonthlyExecutiveReport): ExecutiveNote[] {
  const notes: ExecutiveNote[] = []
  for (const department of ['cafe', 'wash'] as const) {
    const percent = report[department].achievement_percent
    if (percent === null) continue
    notes.push({
      key: `reports.monthly.notes.${department}Target`,
      values: { department, percent },
    })
  }

  const movement = moneyMovement(report.money, report.comparison_figures)
  // The note names WHAT it moved against, so the mode travels with the figure.
  const period = COMPARISON_PERIOD[report.comparison] ?? COMPARISON_PERIOD.PREVIOUS_MONTH
  const largest = (Object.keys(movement) as (keyof typeof movement)[])
    .filter((key) => movement[key].percent !== null)
    // Ties keep the declared order (revenue before expenses before net), so the
    // choice is stable rather than dependent on object iteration.
    .sort(
      (left, right) =>
        Math.abs(movement[right].percent ?? 0) - Math.abs(movement[left].percent ?? 0),
    )[0]
  if (largest) {
    notes.push({
      key: `reports.monthly.notes.${largest}Movement`,
      values: { percent: String(movement[largest].percent), period },
      trend: movement[largest].trend,
    })
  }

  return notes.slice(0, MAX_KEY_NOTES)
}
