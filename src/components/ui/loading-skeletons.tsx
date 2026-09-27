import { Card } from './card'
import { Skeleton } from './skeleton'
import { cn } from '@/lib/utils'

export function ListRowsSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={className} aria-label="جارٍ تحميل المحتوى">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex min-h-16 items-center gap-3 border-b border-border-subtle py-3 last:border-0"
        >
          <Skeleton variant="circle" className="size-10" accessibilityLabel="" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton variant="text" className="w-2/5" accessibilityLabel="" />
            <Skeleton variant="text" className="h-3 w-3/5" accessibilityLabel="" />
          </div>
          <Skeleton variant="text" className="h-6 w-20" accessibilityLabel="" />
        </div>
      ))}
      <output className="sr-only">جارٍ تحميل المحتوى</output>
    </div>
  )
}

export function TableSkeleton({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number
  columns?: number
  className?: string
}) {
  return (
    <div className={className} aria-label="جارٍ تحميل الجدول">
      <div className="flex gap-4 border-b border-border py-2">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} variant="text" className="h-3 flex-1" accessibilityLabel="" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4 border-b border-border-subtle py-3 last:border-0">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              variant="text"
              className="h-4 flex-1"
              accessibilityLabel=""
            />
          ))}
        </div>
      ))}
      <output className="sr-only">جارٍ تحميل الجدول</output>
    </div>
  )
}

/**
 * Chart-grid loading placeholder.
 *
 * A chart surface is not a table, so a table skeleton is the wrong metaphor:
 * it reserves the wrong space and implies columns that do not exist. This
 * mirrors the real donut layout — header, square plot, legend rows — so the
 * grid does not reflow when the report resolves. The whole block is one
 * accessible status; the individual bars are decorative.
 */
export function ChartGridSkeleton({
  charts = 3,
  className,
}: {
  charts?: number
  className?: string
}) {
  return (
    <output
      className={cn('block', className)}
      aria-label="جارٍ تحميل الرسوم البيانية"
      aria-busy="true"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: charts }, (_, index) => (
          <Card key={index} className="min-h-88 space-y-5 p-5">
            <div className="flex items-center gap-3">
              <Skeleton variant="rect" className="size-10" accessibilityLabel="" />
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" className="w-3/5" accessibilityLabel="" />
                <Skeleton variant="text" className="h-3 w-2/5" accessibilityLabel="" />
              </div>
            </div>
            <Skeleton variant="rect" className="mx-auto aspect-square w-56" accessibilityLabel="" />
            <div className="space-y-2.5 border-t border-border-subtle pt-3">
              {Array.from({ length: 2 }, (_, legendIndex) => (
                <div key={legendIndex} className="flex items-center justify-between gap-3">
                  <Skeleton variant="text" className="h-3 w-1/3" accessibilityLabel="" />
                  <Skeleton variant="text" className="h-3 w-1/4" accessibilityLabel="" />
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <span className="sr-only">جارٍ تحميل الرسوم البيانية</span>
    </output>
  )
}

/**
 * Single-chart loading placeholder.
 *
 * The grid variant above is shaped for a three-card report; a page that owns ONE
 * chart needs the same card silhouette (header, plot, legend rows) without the
 * surrounding grid, so the surface does not jump when the data resolves.
 */
export function ChartCardSkeleton({ className }: { className?: string }) {
  return (
    <Card
      className={cn('block min-h-88 space-y-5 p-5', className)}
      aria-busy="true"
      aria-label="جارٍ تحميل الرسم البياني"
      as="output"
    >
      <div className="flex items-center gap-3">
        <Skeleton variant="rect" className="size-10" accessibilityLabel="" />
        <div className="flex-1 space-y-2">
          <Skeleton variant="text" className="w-3/5" accessibilityLabel="" />
          <Skeleton variant="text" className="h-3 w-2/5" accessibilityLabel="" />
        </div>
      </div>
      <Skeleton variant="rect" className="h-72 w-full" accessibilityLabel="" />
      <div className="space-y-2.5 border-t border-border-subtle pt-3">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex items-center justify-between gap-3">
            <Skeleton variant="text" className="h-3 w-1/3" accessibilityLabel="" />
            <Skeleton variant="text" className="h-3 w-1/4" accessibilityLabel="" />
          </div>
        ))}
      </div>
      <span className="sr-only">جارٍ تحميل الرسم البياني</span>
    </Card>
  )
}

export function CardGridSkeleton({ cards = 6, className }: { cards?: number; className?: string }) {
  return (
    <div className={className} aria-label="جارٍ تحميل البيانات">
      {Array.from({ length: cards }, (_, index) => (
        <Card key={index} className="min-h-56 space-y-5">
          <div className="flex items-center gap-3">
            <Skeleton variant="circle" className="size-12" accessibilityLabel="" />
            <div className="flex-1 space-y-2">
              <Skeleton variant="text" className="w-2/5" accessibilityLabel="" />
              <Skeleton variant="text" className="h-3 w-3/5" accessibilityLabel="" />
            </div>
          </div>
          <div className="flex-1 space-y-2">
            <Skeleton variant="text" className="w-1/3" accessibilityLabel="" />
            <Skeleton variant="text" className="w-4/5" accessibilityLabel="" />
          </div>
          <Skeleton className="h-9" accessibilityLabel="" />
        </Card>
      ))}
      <output className="sr-only">جارٍ تحميل البيانات</output>
    </div>
  )
}
