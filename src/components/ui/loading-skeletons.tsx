import { Card } from './card'
import { Skeleton } from './skeleton'

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
      <span className="sr-only" role="status">
        جارٍ تحميل المحتوى
      </span>
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
      <span className="sr-only" role="status">
        جارٍ تحميل الجدول
      </span>
    </div>
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
      <span className="sr-only" role="status">
        جارٍ تحميل البيانات
      </span>
    </div>
  )
}
