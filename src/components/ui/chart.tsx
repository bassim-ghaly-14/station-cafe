import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ResponsiveContainer, Tooltip, type TooltipProps } from 'recharts'

export type ChartConfig = Record<string, { label?: ReactNode; color?: string }>

type ChartPayloadItem = {
  dataKey?: string | number
  value?: number | string
  color?: string
  /** The series name recharts reports for this entry, when the mark has one. */
  name?: string | number
  payload?: { fill?: string; label?: string; value?: number }
}

/**
 * The ENTITY a payload row is about — the sales section, the expense category,
 * the payment method — as opposed to the period or the value.
 *
 * The order matters, and it is the whole fix for a monthly chart:
 *  1. `item.name` is the name of the MARK itself (its `name` prop, or its
 *     `nameKey`). For a bar that is the SERIES — `cafe`, `wash`, or the domain
 *     category code — so it survives a rename and a translation, and it is the
 *     only field that says what the row actually measures.
 *  2. `item.payload.label` is a FALLBACK, and only for a chart whose datum's
 *     `label` IS the entity (a pie using `nameKey="label"`). In a time chart
 *     that same field is the X-AXIS category — a month, a day — so reading it
 *     first would name every row of a month after the month and print no
 *     category at all.
 */
function entryLabel(item: ChartPayloadItem, key: string): string | number {
  if (item.name !== undefined && item.name !== null && item.name !== '') return item.name
  if (item.payload?.label !== undefined && item.payload.label !== '') return item.payload.label
  return key
}

type ChartTooltipContentProps = {
  active?: boolean
  payload?: ChartPayloadItem[]
  label?: string | number
  hideLabel?: boolean
  hideIndicator?: boolean
  indicator?: 'line' | 'dot' | 'dashed'
  /**
   * The DISPLAY name of a row's entity, resolved by the chart that owns the
   * series.
   *
   * It exists because the mark's own `name` is the SERIES KEY — a domain code
   * such as `MAINTENANCE`, `cafe` or `ELECTRICITY`. That key is an internal
   * identity, not a label: it is never English prose, and printing it beside
   * the chart's own Arabic label would show the reader two names for one row
   * ("MAINTENANCE صيانة"). A chart that configures localized series labels
   * passes this so the tooltip prints ONLY the Arabic name, and its `formatter`
   * prints only the value.
   *
   * Returning an empty string prints no name at all, which is the honest
   * answer for a series the chart no longer configures — the internal key is
   * never promoted to a label.
   */
  itemLabel?: (item: ChartPayloadItem, key: string) => ReactNode
  /**
   * Renders the row's name in the project's bold weight (`font-bold`, 700).
   * Off by default so a chart that never asked for it keeps its current
   * typography; the monthly comparison turns it on, where the name is the
   * entity a manager is looking for.
   */
  boldItemLabel?: boolean
  /**
   * Formats the category line. The payload is passed as well, so a chart can
   * label a category with the fuller text its own datum carries (a month with
   * its year, for instance) while the axis keeps the abbreviated form.
   */
  labelFormatter?: (label: ReactNode, payload?: ChartPayloadItem[]) => ReactNode
  labelClassName?: string
  /**
   * Formats ONE VALUE. The name is printed by the row itself (see
   * `itemLabel`), so a formatter returns the figure alone — a formatter that
   * also printed the name would repeat it on the same line.
   */
  formatter?: (value: ReactNode, name: ReactNode, item: ChartPayloadItem) => ReactNode
  /**
   * Optional line under the rows — a total, for instance. Rendered by the same
   * primitive so a chart that has one never hand-builds a tooltip of its own.
   * A function is given the payload, which is how a row-derived figure (the
   * month total of a stack) can be stated without the caller tracking the
   * hovered month itself.
   */
  footer?: ReactNode | ((payload: ChartPayloadItem[]) => ReactNode)
  /**
   * Drops the rows whose value is `0`. A stack names every configured series for
   * the hovered month, and listing a category as zero says "this month had none"
   * about a segment that simply is not drawn — which is a different statement.
   * A chart that does draw a zero bar (a grouped one) leaves this off.
   */
  hideZeroValues?: boolean
  className?: string
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: {
  id?: string
  className?: string
  children: ReactNode
  config: ChartConfig
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const chartStyle = Object.fromEntries(
    Object.entries(config)
      .filter(([, value]) => value.color)
      .map(([key, value]) => [`--color-${key}`, value.color]),
  ) as CSSProperties

  return (
    <div
      data-chart="container"
      data-chart-id={id}
      className={cn('h-full w-full text-xs', className)}
      style={{ ...chartStyle, ...props.style }}
      {...props}
    >
      <ResponsiveContainer width="100%" height="100%">
        {children as React.ReactElement}
      </ResponsiveContainer>
    </div>
  )
}

export function ChartTooltip(props: TooltipProps) {
  // `allowEscapeViewBox` is recharts' own guarantee that a tooltip never leaves
  // the plot rectangle — false on BOTH axes, which is also its default, but it is
  // stated here on purpose: every chart in the app goes through this ONE wrapper,
  // and a tooltip that escapes its plot is a tooltip that escapes the fullscreen
  // card too — exactly the overflow this guard exists to prevent. A caller that
  // genuinely needs different behaviour still wins, because `props` is spread
  // after it.
  return <Tooltip cursor={false} allowEscapeViewBox={{ x: false, y: false }} {...props} />
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  hideLabel = false,
  hideIndicator = false,
  indicator = 'dot',
  itemLabel,
  boldItemLabel = false,
  labelFormatter,
  labelClassName,
  formatter,
  footer,
  hideZeroValues = false,
  className,
}: ChartTooltipContentProps) {
  if (!active || !payload?.length) return null

  const rows = hideZeroValues ? payload.filter((item) => Number(item.value) !== 0) : payload

  return (
    <div
      className={cn(
        'min-w-36 rounded-md border border-border-strong bg-surface-popover px-3 py-2 text-sm shadow-sm',
        className,
      )}
      dir="rtl"
    >
      {!hideLabel && label !== undefined ? (
        <div className={cn('mb-1 font-medium text-foreground-strong', labelClassName)}>
          {labelFormatter ? labelFormatter(label, payload) : label}
        </div>
      ) : null}
      {/* Every row is shown: the grid is a plain wrapping list with NO scroll
          region and no cap, so a many-category tooltip states them all at once
          rather than hiding rows behind a scrollbar. */}
      <div className="grid gap-1.5">
        {rows.map((item, index) => {
          // The row is identified by the SERIES it plots, so two series of the
          // same month are two different rows and never one repeated name.
          const key = String(item.dataKey ?? item.name ?? index)
          // The chart that OWNS the series decides what its name reads like —
          // for Station that is the Arabic domain name, never the series key.
          // A chart that supplies no resolver keeps the mark's own name.
          const label = itemLabel ? itemLabel(item, key) : entryLabel(item, key)
          const color = item.color ?? item.payload?.fill
          // The formatter states the VALUE alone; the name is this row's job.
          const value = formatter?.(item.value, label, item) ?? item.value
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2 text-foreground-muted">
                {!hideIndicator ? (
                  <span
                    className={cn(
                      'shrink-0',
                      indicator === 'line' ? 'h-0.5 w-3' : 'size-2 rounded-full',
                    )}
                    style={{ backgroundColor: color }}
                  />
                ) : null}
                {label === '' || label === undefined || label === null ? null : (
                  <span className={cn('truncate', boldItemLabel && 'font-bold')}>{label}</span>
                )}
              </div>
              <span className="font-medium tabular-nums text-foreground">{value}</span>
            </div>
          )
        })}
      </div>
      {footer ? (
        <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border-subtle pt-1.5 font-medium text-foreground-strong">
          {typeof footer === 'function' ? footer(payload) : footer}
        </div>
      ) : null}
    </div>
  )
}
