'use client'

import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { ImageIcon, Search, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  getImageUrl,
  matchesGlobalKnifeSearch,
  parseGlobalKnifeSearchQuery,
  type Knife,
} from '@/lib/data'
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
  const islandRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const searchHintId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const showGlobalSearch = pathname !== '/collection' && pathname !== '/compare'
  const parsedQuery = useMemo(() => parseGlobalKnifeSearchQuery(query), [query])

  const matchingKnives = useMemo(() => {
    if (!parsedQuery.value) return []
    return knives.filter((knife) => matchesGlobalKnifeSearch(knife, query))
  }, [knives, parsedQuery.value, query])
  const results = matchingKnives.slice(0, MAX_RESULTS)

  const closeSearch = useCallback((restoreFocus = false) => {
    inputRef.current?.blur()
    setOpen(false)
    setQuery('')
    setActiveIndex(0)

    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus())
    }
  }, [])

  const selectKnife = useCallback(
    (knife: Knife) => {
      closeSearch()
      router.push(`/collection/${encodeURIComponent(knife.id)}`)
    },
    [closeSearch, router],
  )

  useEffect(() => {
    if (!open) return

    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    const handlePointerDown = (event: PointerEvent) => {
      if (!islandRef.current?.contains(event.target as Node)) {
        closeSearch()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [closeSearch, open])

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
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch(true)
      return
    }

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

  const hasSearchTerm = parsedQuery.value.length > 0
  const isModelNumberSearch = parsedQuery.mode === 'model-number'
  const activeResult = results[activeIndex]

  if (!showGlobalSearch) return null

  return (
    <div
      ref={islandRef}
      data-global-knife-search
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'fixed top-2 z-40 overflow-hidden border border-[var(--bladevault-line)]/80 bg-popover text-popover-foreground print:hidden motion-reduce:transition-none',
        'transition-[left,right,width,border-radius,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        open
          ? 'right-2 left-2 w-auto rounded-[1.2rem] shadow-[0_16px_48px_rgba(31,27,17,0.22)] md:right-auto md:left-1/2 md:w-[22rem] md:-translate-x-1/2'
          : 'right-16 w-16 rounded-full shadow-[0_6px_24px_rgba(31,27,17,0.14)] min-[380px]:w-[8.5rem] md:right-auto md:left-1/2 md:-translate-x-1/2',
      )}
    >
      <div
        className={cn(
          'relative transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          open ? 'h-10' : 'h-8',
        )}
      >
        {open ? (
          <div
            role="search"
            aria-label="Find a knife"
            className="absolute inset-0 flex animate-in items-center gap-2.5 px-3 fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
          >
            <Search
              className="size-4 shrink-0 text-[var(--bladevault-title)]"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Find a model…"
              aria-label="Find a knife by model name"
              aria-describedby={searchHintId}
              aria-autocomplete="list"
              aria-controls={hasSearchTerm ? listboxId : undefined}
              aria-expanded={hasSearchTerm}
              aria-activedescendant={
                activeResult ? `${listboxId}-${activeResult.id}` : undefined
              }
              className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
            />
            <button
              type="button"
              onClick={() => closeSearch(true)}
              aria-label="Close search"
              className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Search knives"
            aria-keyshortcuts="/"
            className="absolute inset-0 flex w-full min-w-0 animate-in items-center justify-center gap-2 overflow-hidden px-2 text-[11px] font-medium text-muted-foreground fade-in-0 duration-200 hover:bg-[color:var(--bladevault-surface-soft)]/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:scale-[0.98] min-[380px]:px-3 motion-reduce:animate-none"
          >
            <Search
              className="size-3.5 text-[var(--bladevault-title)]"
              aria-hidden="true"
            />
            <span className="min-[380px]:hidden">Find</span>
            <span className="hidden min-[380px]:inline">Find a knife</span>
            <kbd className="hidden rounded-md border border-[var(--bladevault-line)]/65 bg-[color:var(--bladevault-surface-soft)]/75 px-1.5 py-0.5 font-mono text-[9px] leading-none text-muted-foreground min-[380px]:inline-flex">
              /
            </kbd>
          </button>
        )}
      </div>

      <div
        aria-hidden={!open}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          open
            ? 'grid-rows-[1fr] border-t border-[var(--bladevault-line)]/55 opacity-100'
            : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            id={searchHintId}
            className="flex items-center gap-2 px-3 py-2 text-[10px] text-muted-foreground"
          >
            {isModelNumberSearch ? (
              <>
                <span className="font-medium text-[var(--bladevault-title)]">
                  Model number mode
                </span>
                <span>Type a model number to search.</span>
              </>
            ) : (
              <>
                <span>Tip</span>
                <span>
                  Use{' '}
                  <kbd className="rounded border border-[var(--bladevault-line)]/70 bg-background px-1.5 py-0.5 font-mono text-[9px] text-foreground">
                    /model A4301
                  </kbd>{' '}
                  to search model numbers only.
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div
        aria-hidden={!hasSearchTerm}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          open && hasSearchTerm
            ? 'grid-rows-[1fr] border-t border-[var(--bladevault-line)]/55 opacity-100'
            : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            id={listboxId}
            role="listbox"
            aria-label="Knife search results"
            className="max-h-[min(25rem,calc(100dvh-6.5rem))] overflow-y-auto p-1.5"
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
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {knife.name}
                        </span>
                        {isModelNumberSearch && knife.specs.modelNumber && (
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {knife.specs.modelNumber}
                          </span>
                        )}
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
                No {isModelNumberSearch ? 'model number' : 'model'} matches “
                {parsedQuery.value}”.
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
      </div>
    </div>
  )
}
