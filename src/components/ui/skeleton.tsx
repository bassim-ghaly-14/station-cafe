import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const skeletonVariants = cva('block animate-pulse bg-skeleton motion-reduce:animate-none', {
  variants: {
    variant: {
      rect: 'rounded-md',
      text: 'h-4 rounded-sm',
      circle: 'rounded-full',
    },
  },
  defaultVariants: { variant: 'rect' },
})

export interface SkeletonProps
  extends HTMLAttributes<HTMLElement>, VariantProps<typeof skeletonVariants> {
  /** Defaults to the Arabic production loading label; use an empty string for decorative groups. */
  accessibilityLabel?: string
}

/** A composable placeholder that preserves loading layout without fake content. */
export function Skeleton({
  variant,
  accessibilityLabel = 'جارٍ التحميل…',
  className,
  ...props
}: Readonly<SkeletonProps>) {
  const labelled = accessibilityLabel.length > 0
  return (
    <output
      aria-label={labelled ? accessibilityLabel : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn(skeletonVariants({ variant }), className)}
      {...props}
    />
  )
}
