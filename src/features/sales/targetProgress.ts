/**
 * How the Sales page presents the backend's monthly target figures.
 *
 * Everything here is PRESENTATION of values the domain already resolved. No
 * function in this file computes revenue, a remainder or an achievement — those
 * arrive whole from `sales_target_progress`, and duplicating any of them in the
 * UI is exactly how a screen and a report start disagreeing about the same
 * month.
 *
 * Two rules live here, and both are about DRAWING rather than deciding:
 *
 *  - the FILLED WIDTH of a progress bar is capped at 100%, because a bar that
 *    runs off its own track stops being readable — while the NUMBER beside it
 *    keeps saying `114.29`. Capping the drawing is not capping the business.
 *  - a month with no target renders no percentage at all, never `0%`, which
 *    would claim nothing was achieved when nothing was measured.
 *
 * The percentages are printed from the backend's own two-decimal strings and its
 * integer hundredths; only the bar geometry is computed here.
 */
import type { TargetDayRow } from '@/services/salesApi'

/** The bar's filled width, 0–100. A passed target fills the track and no more. */
export function fillWidth(achievementHundredths: number | null): number {
  if (achievementHundredths === null || achievementHundredths <= 0) return 0
  return Math.min(100, achievementHundredths / 100)
}

/**
 * The percentage to PRINT, or null when there is no target to measure against.
 *
 * The backend sends a ready two-decimal string, so this passes it through: a
 * component cannot accidentally format a different number than the domain
 * resolved.
 */
export function achievementText(achievementPercent: string | null): string | null {
  return achievementPercent
}

/** One department's daily line, ready to render. */
export type TargetDayLine = {
  dayDate: string
  /** That day's revenue for this department. */
  revenue: number
  /** Revenue from the first of the month through this day. */
  cumulative: number
  /** Two-decimal percentage of the MONTHLY target, or null when there is none. */
  achievementPercent: string | null
  /** 0–100 for the bar; the printed figure beside it may exceed it. */
  fill: number
}

/** Formats hundredths of a percent the way the backend does: two decimals. */
function percentFromHundredths(hundredths: number | null): string | null {
  if (hundredths === null) return null
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`
}

/**
 * The month's days for ONE department, oldest first.
 *
 * Each row's percentage is the backend's own cumulative achievement against the
 * FULL monthly target — the owner set one number for the month, so every day
 * reports how much of THAT number has been earned by then, and no "daily target"
 * is invented anywhere.
 */
export function departmentDays(
  daily: readonly TargetDayRow[],
  department: 'CAFE' | 'WASH',
): TargetDayLine[] {
  const isCafe = department === 'CAFE'
  return daily.map((day) => {
    const hundredths = isCafe ? day.cafe_achievement_hundredths : day.wash_achievement_hundredths
    return {
      dayDate: day.day_date,
      revenue: isCafe ? day.cafe_revenue : day.wash_revenue,
      cumulative: isCafe ? day.cafe_cumulative : day.wash_cumulative,
      achievementPercent: percentFromHundredths(hundredths),
      fill: fillWidth(hundredths),
    }
  })
}
