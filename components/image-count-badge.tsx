import { ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ImageCountBadge({
  count,
  size = 'md',
  className,
}: {
  count: number
  size?: 'sm' | 'md'
  className?: string
}) {
  if (count <= 0) return null

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-semibold tabular-nums transition-all',
        'border-[var(--bladevault-gold)] bg-white text-[var(--bladevault-olive)] shadow-sm',
        'dark:border-[var(--bladevault-gold)] dark:bg-[var(--bladevault-olive)] dark:text-[var(--bladevault-gold)]',
        size === 'sm' && 'px-2 py-0.5 text-[10px]',
        size === 'md' && 'px-2.5 py-1 text-xs',
        className,
      )}
      aria-label={`${count} image${count === 1 ? '' : 's'}`}
    >
      <ImageIcon
        className={cn(
          'shrink-0',
          size === 'sm' && 'h-3 w-3',
          size === 'md' && 'h-3.5 w-3.5',
        )}
        aria-hidden="true"
      />
      {count}
    </span>
  )
}
