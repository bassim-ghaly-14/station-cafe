import { cn } from '@/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { Loader } from './loader'

const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.98] disabled:pointer-events-none disabled:text-foreground-disabled disabled:opacity-70 aria-disabled:pointer-events-none aria-disabled:text-foreground-disabled aria-disabled:opacity-70 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover active:bg-primary-active',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-secondary-active',
        outline:
          'border border-border-accent bg-transparent text-foreground hover:border-border-accent-hover hover:bg-accent active:border-border-accent-hover active:bg-accent-hover',
        ghost:
          'text-foreground-muted hover:bg-surface-hover hover:text-foreground active:bg-surface-active',
        destructive:
          'bg-destructive-solid text-destructive-solid-foreground shadow-sm hover:bg-destructive-solid-hover active:bg-destructive-solid-active',
        destructiveGhost:
          'text-destructive-soft-foreground hover:bg-destructive-soft hover:text-destructive active:bg-destructive-soft-hover active:text-destructive',
        /**
         * The affirmative counterpart to `destructive`: an action that ENABLES
         * something. Used by the catalog's "activate" control so the button
         * color always matches the outcome of pressing it.
         */
        success:
          'bg-success-solid text-success-solid-foreground shadow-sm hover:bg-success-solid-hover active:bg-success-solid-active',
        link: 'text-foreground-muted underline-offset-4 hover:text-foreground hover:underline',
      },
      size: {
        sm: 'h-9 min-h-9 px-3 text-sm [&_svg]:size-4',
        md: 'h-10 min-h-10 px-4 text-base [&_svg]:size-4',
        lg: 'h-12 min-h-12 px-6 text-base font-bold [&_svg]:size-5',
        icon: 'h-10 w-10 min-h-10 min-w-10 [&_svg]:size-4',
        'icon-sm': 'h-9 w-9 min-h-9 min-w-9 [&_svg]:size-4',
        'icon-lg': 'h-12 w-12 min-h-12 min-w-12 [&_svg]:size-5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner, announces busy state and blocks interaction. */
  loading?: boolean
}

export function Button({
  className,
  variant,
  size,
  type = 'button',
  loading = false,
  disabled,
  children,
  ...props
}: Readonly<ButtonProps>) {
  const isDisabled = disabled || loading
  return (
    <button
      type={type}
      aria-busy={loading || undefined}
      disabled={isDisabled}
      className={cn(buttonVariants({ variant, size }), loading && 'cursor-wait', className)}
      {...props}
    >
      {loading ? <Loader size="sm" /> : null}
      {children}
    </button>
  )
}

export { buttonVariants }
