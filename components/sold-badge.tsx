import { cn } from '@/lib/utils'

export function SoldBadge({ className }: { className?: string }) {
  return (
    <span
      data-sold-badge
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] font-semibold leading-none text-foreground',
        className,
      )}
    >
      Sold
    </span>
  )
}
