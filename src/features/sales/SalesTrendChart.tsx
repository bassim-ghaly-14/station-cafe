/**
 * The sales trend.
 *
 * Revenue as columns, invoice count as a line on its own axis, so the manager
 * can see the two movements together: a quiet day with a big average and a busy
 * day of small tickets do not look alike on a single scale.
 *
 * Chart decisions, and why:
 *  - **recharts** is already the project's charting dependency (the reports
 *    donuts use it), so no new library is introduced.
 *  - The plot is `dir="ltr"` — recharts lays out on a left-to-right axis — while
 *    every visible label stays Arabic and inside its own isolate. The tooltip
 *    keeps RTL, because that is prose.
 *  - Colors come from the centralized Station tokens (`--primary`, `--info`),
 *    so light and dark mode are the theme's decision, not the component's.
 *  - A single-day period has no movement to plot, so it is stated as a fact
 *    instead of a one-column chart.
 *  - RTL, light and dark are all covered by the token choices; there is no
 *    per-theme branch in this file.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import {
  Card,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  MoneyDisplay,
} from '@/components/ui'
import { formatDate } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import type { SalesDayRow } from '@/services/salesApi'

export function SalesTrendChart({
  trend,
  className,
}: {
  trend: SalesDayRow[]
  className?: string
}) {
  const { t } = useTranslation()

  // Chart data is a pure rename of the DTO — no aggregation happens in the view.
  const data = useMemo(
    () =>
      trend.map((day) => ({
        day_date: day.day_date,
        label: formatDate(day.day_date),
        total_sales: day.total_sales,
        invoices_count: day.invoices_count,
      })),
    [trend],
  )

  const peak = useMemo(
    () =>
      trend.reduce<SalesDayRow | null>(
        (best, day) => (!best || day.total_sales > best.total_sales ? day : best),
        null,
      ),
    [trend],
  )

  if (trend.length === 0) {
    return (
      <Card className={className}>
        <TrendHeading />
        <p className="py-6 text-center text-body text-foreground-muted">{t('sales.trend.empty')}</p>
      </Card>
    )
  }

  // One business day has no movement: a single column would be decoration.
  if (trend.length === 1) {
    const day = trend[0]
    return (
      <Card className={className}>
        <TrendHeading />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-caption text-foreground-subtle">
              {t('sales.trend.singleDay', { date: formatDate(day.day_date) })}
            </p>
            <MoneyDisplay
              amount={day.total_sales}
              variant="auto"
              className="text-2xl font-extrabold text-foreground-strong"
            />
          </div>
          <p className="text-caption text-foreground-muted">
            {t('sales.trend.invoicesOn', { count: day.invoices_count })}
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <TrendHeading
        aside={
          peak && peak.total_sales > 0
            ? t('sales.trend.peak', {
                date: formatDate(peak.day_date),
                amount: formatMinorMoney(peak.total_sales),
              })
            : undefined
        }
      />
      {/* The plot reads left-to-right like the calendar; the labels do not. */}
      <div dir="ltr" className="h-64 w-full">
        <ChartContainer
          config={{
            total_sales: { label: t('sales.kpi.revenue'), color: 'var(--primary)' },
            invoices_count: { label: t('sales.kpi.invoices'), color: 'var(--info)' },
          }}
        >
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis
              yAxisId="money"
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(value: number) => formatMinorMoney(value, { compact: true })}
            />
            <YAxis yAxisId="count" orientation="right" hide />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  // Each row carries the FORMATTED DATE under `label` (the axis
                  // needs it), and the shared tooltip would otherwise print
                  // that date as the name of BOTH series. The series name is
                  // taken from the mark instead, so the tooltip always reads
                  // "إجمالي المبيعات" and "عدد الفواتير".
                  formatter={(value, _name, item) =>
                    item.name === 'invoices_count'
                      ? t('sales.trend.invoicesOn', { count: Number(value) })
                      : formatMinorMoney(Number(value))
                  }
                />
              }
            />
            <Bar
              yAxisId="money"
              dataKey="total_sales"
              name="total_sales"
              fill="var(--primary)"
              radius={[3, 3, 0, 0]}
              maxBarSize={44}
              isAnimationActive={false}
            />
            <Line
              yAxisId="count"
              type="monotone"
              dataKey="invoices_count"
              name="invoices_count"
              stroke="var(--info)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartContainer>
      </div>
    </Card>
  )
}

function TrendHeading({ aside }: { aside?: string }) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="text-section text-foreground-strong">{t('sales.trend.title')}</h2>
        <p className="mt-0.5 text-caption text-foreground-subtle">{t('sales.trend.hint')}</p>
      </div>
      {aside ? <p className="text-caption text-foreground-muted">{aside}</p> : null}
    </div>
  )
}
