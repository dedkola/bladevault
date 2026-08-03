'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type FilterMultiSelectProps = {
  label: string
  options: string[]
  selectedValues: string[]
  onToggleValue: (value: string) => void
  onSelectAll: () => void
  onClear: () => void
  getOptionLabel?: (value: string) => string
  className?: string
}

export function FilterMultiSelect({
  label,
  options,
  selectedValues,
  onToggleValue,
  onSelectAll,
  onClear,
  getOptionLabel = (value) => value,
  className,
}: FilterMultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const closeMenu = useCallback(() => {
    setIsOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closeMenu()
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [closeMenu, isOpen])

  useEffect(() => {
    if (!isOpen) return

    searchInputRef.current?.focus()
  }, [isOpen])

  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return options
    }

    return options.filter((option) =>
      getOptionLabel(option).toLowerCase().includes(normalizedQuery),
    )
  }, [getOptionLabel, options, query])

  const triggerLabel = useMemo(() => {
    if (selectedValues.length === 0) {
      return label
    }

    if (selectedValues.length <= 2) {
      return `${label}: ${selectedValues.map(getOptionLabel).join(', ')}`
    }

    return `${label}: ${selectedValues.length} selected`
  }, [getOptionLabel, label, selectedValues])

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        onClick={() => {
          if (isOpen) {
            closeMenu()
            return
          }

          setIsOpen(true)
        }}
        className={cn(
          'h-8 w-full justify-between gap-2 px-2.5 text-left hover:border-primary/50',
          selectedValues.length > 0 && 'border-primary/60 bg-primary/5',
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {selectedValues.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
              {selectedValues.length}
            </span>
          )}
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform',
              isOpen && 'rotate-180',
            )}
          />
        </span>
      </Button>

      {isOpen && (
        <div className="absolute left-0 top-full z-30 mt-2 w-full min-w-[16rem] rounded-xl border bg-popover p-2 shadow-lg">
          <div className="mb-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${label.toLowerCase()}...`}
                className="h-8 pl-8 pr-7 text-xs"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  aria-label={`Clear ${label} search`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onSelectAll}
            >
              All
            </Button>
            {selectedValues.length > 0 && (
              <Button type="button" variant="ghost" size="xs" onClick={onClear}>
                Clear
              </Button>
            )}
          </div>

          <div
            className="max-h-64 overflow-y-auto"
            role="listbox"
            aria-multiselectable="true"
          >
            {visibleOptions.length === 0 ? (
              <div className="rounded-lg px-2 py-3 text-xs text-muted-foreground">
                No matching options.
              </div>
            ) : (
              <div className="space-y-1">
                {visibleOptions.map((option) => {
                  const isSelected = selectedValues.includes(option)

                  return (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => onToggleValue(option)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                        isSelected && 'bg-accent/70 text-accent-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-input',
                          isSelected &&
                            'border-primary bg-primary text-primary-foreground',
                        )}
                      >
                        <Check
                          className={cn('h-3 w-3', !isSelected && 'opacity-0')}
                        />
                      </span>
                      <span className="truncate">{getOptionLabel(option)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
