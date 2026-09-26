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

type ChartTooltipContentProps = {
  active?: boolean
  payload?: ChartPayloadItem[]
  label?: string | number
  hideLabel?: boolean
  hideIndicator?: boolean
  indicator?: 'line' | 'dot' | 'dashed'
  labelFormatter?: (label: ReactNode) => ReactNode
  labelClassName?: string
  formatter?: (value: ReactNode, name: ReactNode, item: ChartPayloadItem) => ReactNode
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
  return <Tooltip cursor={false} {...props} />
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  hideLabel = false,
  hideIndicator = false,
  indicator = 'dot',
  labelFormatter,
  labelClassName,
  formatter,
  className,
}: ChartTooltipContentProps) {
  if (!active || !payload?.length) return null

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
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      ) : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = String(item.dataKey ?? item.payload?.label ?? index)
          const label = item.payload?.label ?? key
          const color = item.color ?? item.payload?.fill
          const value = formatter?.(item.value, label, item) ?? item.value
          return (
            <div key={label} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-foreground-muted">
                {!hideIndicator ? (
                  <span
                    className={cn(
                      'shrink-0',
                      indicator === 'line' ? 'h-0.5 w-3' : 'size-2 rounded-full',
                    )}
                    style={{ backgroundColor: color }}
                  />
                ) : null}
                <span>{label}</span>
              </div>
              <span className="font-medium tabular-nums text-foreground">{value}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
