import { Button } from '@/components/ui'

export function QtyStepper({
  qty,
  min = 1,
  onChange,
  big,
}: {
  qty: number
  min?: number
  onChange: (q: number) => void
  big?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        variant="outline"
        size={big ? 'md' : 'sm'}
        onClick={() => onChange(Math.max(min, qty - 1))}
      >
        −
      </Button>
      <span className="w-8 text-center tabular-nums">{qty}</span>
      <Button variant="outline" size={big ? 'md' : 'sm'} onClick={() => onChange(qty + 1)}>
        +
      </Button>
    </span>
  )
}
