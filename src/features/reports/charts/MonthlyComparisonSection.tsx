/**
 * The monthly comparison section of the Reports → Charts tab.
 *
 * It is a SECTION, not a chart: it renders the two monthly comparison charts
 * that already exist — the Sales one (Cafe vs Wash) and the Expenses one (spend
 * by category) — under one heading, below the period-scoped analytics charts.
 * It owns NO data and NO logic of its own: each chart brings its own hook, its
 * own command, its own window and its own loading/empty/error states, exactly
 * as it did on the page it came from. Nothing here re-reads the reports period
 * picker, and nothing here recomputes a figure.
 *
 * It exists so the two calendar comparisons are found in one place — the place
 * that already holds the reporting charts — while each chart keeps its own
 * domain file, its own series keys and its own colour tokens.
 */
import { useTranslation } from 'react-i18next'
import { ExpensesMonthlyChart } from '@/features/expenses/ExpensesMonthlyChart'
import { SalesMonthlyRevenueChart } from '@/features/sales/SalesMonthlyRevenueChart'

export function MonthlyComparisonSection() {
  const { t } = useTranslation()
  return (
    <section
      className="flex flex-col gap-3 border-t border-border-subtle pt-4"
      aria-labelledby="monthly-comparison-heading"
      data-testid="monthly-comparison-section"
    >
      <div className="min-w-0">
        <h2 id="monthly-comparison-heading" className="text-section text-foreground-strong">
          {t('reports.charts.monthlySectionTitle')}
        </h2>
        <p className="mt-0.5 text-caption text-foreground-subtle">
          {t('reports.charts.monthlySectionDescription')}
        </p>
      </div>
      {/* One column on a phone, two side by side once there is room: both are
          bar charts over the same calendar window and read as a pair. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SalesMonthlyRevenueChart />
        <ExpensesMonthlyChart />
      </div>
    </section>
  )
}
