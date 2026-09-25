import { Loader2 } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'
import type { SVGAttributes } from 'react'
import { cn } from '@/lib/utils'

const loaderVariants = cva('shrink-0 text-current motion-reduce:animate-none', {
  variants: {
    size: {
      sm: 'size-4',
      md: 'size-6',
      lg: 'size-8',
    },
  },
  defaultVariants: { size: 'md' },
})

export interface LoaderProps
  extends Omit<SVGAttributes<SVGSVGElement>, 'children'>, VariantProps<typeof loaderVariants> {
  /** Supply for a standalone loader. Inline decorative loaders remain hidden from assistive technology. */
  label?: string
}

/** Lightweight circular progress indicator for compact asynchronous operations. */
export function Loader({ size, label, className, ...props }: LoaderProps) {
  return (
    <Loader2
      {...props}
      className={cn('animate-spin', loaderVariants({ size }), className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
