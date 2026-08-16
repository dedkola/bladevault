'use client'

import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { ImageIcon, Search, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { getImageUrl, matchesKnifeSearch, type Knife } from '@/lib/data'
import { cn } from '@/lib/utils'

const MAX_RESULTS = 7

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

export function GlobalKnifeSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const { knives, isLoading } = useKnives()
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const showGlobalSearch = pathname !== '/collection' && pathname !== '/compare'

  const matchingKnives = useMemo(() => {
    if (!query.trim()) return []
    return knives.filter((knife) => matchesKnifeSearch(knife, query))
  }, [knives, query])
  const results = matchingKnives.slice(0, MAX_RESULTS)

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [])

  const selectKnife = useCallback(
    (knife: Knife) => {
      handleOpenChange(false)
      router.push(`/collection/${encodeURIComponent(knife.id)}`)
    },
    [handleOpenChange, router],
  )

  useEffect(() => {
    if (!showGlobalSearch) return

    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== '/' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return
      }

      const target = event.target as HTMLElement | null
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) {
        return
      }

      event.preventDefault()
      setOpen(true)
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [showGlobalSearch])

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectKnife(results[activeIndex] ?? results[0])
    }
  }

  const hasQuery = query.trim().length > 0
  const activeResult = results[activeIndex]

  if (!showGlobalSearch) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search knives"
          aria-keyshortcuts="/"
          className="fixed top-2 left-1/2 z-40 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--bladevault-line)]/80 bg-popover/90 px-3 text-[11px] font-medium text-muted-foreground shadow-[0_6px_24px_rgba(31,27,17,0.14)] backdrop-blur-md transition-[color,background-color,box-shadow,transform] hover:bg-popover hover:text-foreground hover:shadow-[0_8px_28px_rgba(31,27,17,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] print:hidden"
        >
          <Search
            className="size-3.5 text-[var(--bladevault-title)]"
            aria-hidden="true"
          />
          <span>Find a knife</span>
          <kbd className="rounded-md border border-[var(--bladevault-line)]/65 bg-[color:var(--bladevault-surface-soft)]/75 px-1.5 py-0.5 font-mono text-[9px] leading-none text-muted-foreground">
            /
          </kbd>
        </button>
      )}
      {open && (
        <DialogContent
          showCloseButton={false}
          className="top-3 w-[calc(100%-1.5rem)] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-[1.65rem] border border-[var(--bladevault-line)]/80 bg-popover/95 p-0 shadow-[0_22px_70px_rgba(31,27,17,0.28)] ring-0 supports-backdrop-filter:backdrop-blur-xl sm:top-6"
        >
          <DialogTitle className="sr-only">Find a knife</DialogTitle>
          <DialogDescription className="sr-only">
            Search your collection by model name and open a knife.
          </DialogDescription>

          <div className="flex h-14 items-center gap-3 px-4">
            <Search
              className="size-4 shrink-0 text-[var(--bladevault-title)]"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Find a model…"
              aria-label="Find a knife by model name"
              aria-autocomplete="list"
              aria-controls={hasQuery ? listboxId : undefined}
              aria-expanded={hasQuery}
              aria-activedescendant={
                activeResult ? `${listboxId}-${activeResult.id}` : undefined
              }
              className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  setActiveIndex(0)
                  inputRef.current?.focus()
                }}
                aria-label="Clear search"
                className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              aria-label="Close search"
              className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </div>

          {hasQuery && (
            <div className="border-t border-[var(--bladevault-line)]/55">
              <div
                id={listboxId}
                role="listbox"
                aria-label="Knife search results"
                className="max-h-[min(25rem,calc(100dvh-7rem))] overflow-y-auto p-1.5"
              >
                {isLoading ? (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    Loading collection…
                  </div>
                ) : results.length > 0 ? (
                  results.map((knife, index) => {
                    const isActive = index === activeIndex

                    return (
                      <button
                        key={knife.id}
                        id={`${listboxId}-${knife.id}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => selectKnife(knife)}
                        className={cn(
                          'relative flex w-full items-center gap-3 overflow-hidden rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                          isActive
                            ? 'bg-[color:var(--bladevault-surface-hover)]/70'
                            : 'hover:bg-[color:var(--bladevault-surface-soft)]/70',
                        )}
                      >
                        <span
                          className={cn(
                            'absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--bladevault-gold)] transition-opacity',
                            isActive ? 'opacity-100' : 'opacity-0',
                          )}
                          aria-hidden="true"
                        />
                        <span className="relative h-11 w-14 shrink-0 overflow-hidden rounded-lg border border-[var(--bladevault-line)]/60 bg-white">
                          {knife.images.length > 0 ? (
                            <Image
                              src={getImageUrl(knife.images[0])}
                              alt=""
                              fill
                              sizes="56px"
                              className="object-contain"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center bg-muted/30">
                              <ImageIcon className="size-4 text-muted-foreground/45" />
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                            {knife.brand}
                          </span>
                          <span className="block truncate text-sm font-medium text-foreground">
                            {knife.name}
                          </span>
                        </span>
                        {isActive && (
                          <span className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:flex">
                            Open
                            <kbd className="rounded-md border border-[var(--bladevault-line)]/70 bg-background px-1.5 py-0.5 font-mono text-[9px]">
                              ↵
                            </kbd>
                          </span>
                        )}
                      </button>
                    )
                  })
                ) : (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No model matches “{query.trim()}”.
                  </div>
                )}
              </div>

              {results.length > 0 && (
                <div className="flex items-center justify-between border-t border-[var(--bladevault-line)]/45 px-4 py-2 text-[10px] text-muted-foreground">
                  <span>
                    {results.length}
                    {matchingKnives.length > MAX_RESULTS ? '+' : ''}{' '}
                    {results.length === 1 ? 'match' : 'matches'}
                  </span>
                  <span className="hidden items-center gap-2 sm:flex">
                    <span>↑↓ choose</span>
                    <span>esc close</span>
                  </span>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}
