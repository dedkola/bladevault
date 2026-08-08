'use client'

import dynamic from 'next/dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { KnifeCard } from '@/components/knife-card'
import { SearchField } from '@/components/search-field'
import { useKnives } from '@/components/providers/knives-provider'
import { matchesKnifeSearch, prioritizePinnedKnives } from '@/lib/data'
import { useDebouncedValue } from '@/lib/use-debounced-value'

const CollectionPulse = dynamic(
  () =>
    import('@/components/collection-pulse').then((mod) => mod.CollectionPulse),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden="true"
        className="min-h-[18rem] animate-pulse rounded-xl bg-card ring-1 ring-foreground/10"
      />
    ),
  },
)

const RECENTLY_ADDED_LIMIT = 12

export default function Dashboard() {
  const { knives, pinnedItemsFirst } = useKnives()
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const debouncedQuery = useDebouncedValue(query, 200)

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable

      if (event.key === '/' && !isTyping) {
        event.preventDefault()
        searchInputRef.current?.focus()
        return
      }

      if (
        event.key === 'Escape' &&
        document.activeElement === searchInputRef.current &&
        query
      ) {
        event.preventDefault()
        setQuery('')
      }
    }

    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [query])

  const visibleKnives = useMemo(
    () =>
      prioritizePinnedKnives(
        knives.filter((knife) => matchesKnifeSearch(knife, debouncedQuery)),
        pinnedItemsFirst,
      ),
    [knives, debouncedQuery, pinnedItemsFirst],
  )

  const recentKnives = visibleKnives.slice(0, RECENTLY_ADDED_LIMIT)
  const hasMore = visibleKnives.length > RECENTLY_ADDED_LIMIT

  return (
    <div className="flex-1 p-6 lg:p-8 w-full max-w-7xl mx-auto">
      <PageHeader
        title="Collection Dashboard"
        actions={
          knives.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/collection">View all</Link>}
              nativeButton={false}
            />
          ) : undefined
        }
      />

      {knives.length > 0 && (
        <div className="mb-5">
          <CollectionPulse knives={knives} />
        </div>
      )}

      {knives.length > 0 && (
        <div className="mb-8">
          <SearchField
            value={query}
            onChange={setQuery}
            inputRef={searchInputRef}
            shortcutHint="/"
          />
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-tight text-[var(--bladevault-title)]">
          Recently Added
        </h2>
      </div>

      {knives.length === 0 ? (
        <EmptyState
          title="No knives yet"
          description="Your collection is empty. Use Quick Add to add your first knife."
          action={
            <Button
              size="sm"
              render={<Link href="/add">Add your first knife</Link>}
              nativeButton={false}
            />
          }
        />
      ) : visibleKnives.length === 0 ? (
        <EmptyState
          title="No matches found"
          description={`Nothing matches "${query}". Try a different brand or model.`}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-6 [overflow-anchor:none] sm:grid-cols-2 lg:grid-cols-4">
            {recentKnives.map((knife, index) => (
              <KnifeCard key={knife.id} knife={knife} eager={index === 0} />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                render={<Link href="/collection">View all</Link>}
                nativeButton={false}
              >
                View all {visibleKnives.length} knives
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
