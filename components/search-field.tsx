'use client'

import { useRef, type RefObject } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type SearchFieldProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
  shortcutHint?: string
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search brand or model…',
  className,
  inputRef,
  shortcutHint,
}: SearchFieldProps) {
  const fallbackInputRef = useRef<HTMLInputElement>(null)
  const resolvedInputRef = inputRef ?? fallbackInputRef

  const clearSearch = () => {
    onChange('')
    resolvedInputRef.current?.focus()
  }

  return (
    <div className={cn('mx-auto w-full max-w-xs', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={resolvedInputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn('h-8 pl-8 text-xs', shortcutHint ? 'pr-12' : 'pr-7')}
        />
        {value ? (
          <button
            type="button"
            onClick={clearSearch}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : shortcutHint ? (
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] leading-none text-muted-foreground sm:inline-flex">
            {shortcutHint}
          </kbd>
        ) : null}
      </div>
    </div>
  )
}
