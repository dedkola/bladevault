'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Plus, Scale } from 'lucide-react'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export function ComparisonNavigation({
  onNavigate,
}: {
  onNavigate?: () => void
}) {
  const { lists, active, open, loading, error, refresh } = useComparisons()
  const pathname = usePathname(),
    selected = pathname === '/compare'
  const [query, setQuery] = useState(''),
    [limit, setLimit] = useState(50)
  const filtered = lists.filter((l) =>
    l.name.toLowerCase().includes(query.toLowerCase()),
  )
  function create() {
    onNavigate?.()
    open({ kind: 'create' })
  }
  return (
    <div>
      <div
        className={cn(
          'flex items-center rounded-lg transition-colors',
          selected &&
            'bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)]',
        )}
      >
        <Link
          href={
            active
              ? `/compare?list=${encodeURIComponent(active.id)}`
              : '/compare'
          }
          onClick={onNavigate}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
            selected
              ? 'text-[var(--bladevault-gold)]'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Scale className="size-4" />
          <span className="flex-1">Compare</span>
        </Link>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={create}
          disabled={loading || Boolean(error)}
          className={cn(
            'mr-0.5',
            selected &&
              'text-[var(--bladevault-gold)] hover:bg-[var(--bladevault-gold)]/15 hover:text-[var(--bladevault-gold)] focus-visible:ring-[var(--bladevault-gold)]/70',
          )}
          aria-label="New comparison"
          title="New comparison"
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {loading ? (
        <div role="status" className="ml-7 space-y-2 py-3">
          <span className="sr-only">Loading comparisons</span>
          <div className="h-5 animate-pulse rounded bg-muted" />
          <div className="h-5 animate-pulse rounded bg-muted" />
        </div>
      ) : error ? (
        <div className="p-2">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="my-1 ml-4">
          {lists.length > 6 && (
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setLimit(50)
              }}
              aria-label="Find comparison"
              placeholder="Find comparison…"
              className="my-2 h-8 text-xs"
            />
          )}
          {filtered.slice(0, limit).map((l) => (
            <Link
              key={l.id}
              href={`/compare?list=${encodeURIComponent(l.id)}`}
              onClick={onNavigate}
              title={l.name}
              aria-current={
                selected && active?.id === l.id ? 'page' : undefined
              }
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-2 text-xs',
                selected && active?.id === l.id
                  ? 'bg-accent font-semibold text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              <span
                className={cn(
                  'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                  selected && active?.id === l.id
                    ? 'bg-accent-foreground text-accent'
                    : 'bg-muted text-foreground',
                )}
              >
                {l.ids.length}
              </span>
            </Link>
          ))}
          {filtered.length > limit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLimit((n) => n + 50)}
            >
              Show more
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
