'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Dialog } from '@base-ui/react/dialog'
import { ArrowRight, Search, Settings } from 'lucide-react'
import { OPEN_GLOBAL_SEARCH_EVENT } from '@/components/global-knife-search'
import { BatchScrapeDialog } from '@/components/batch-scrape-dialog'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import { useKnives } from '@/components/providers/knives-provider'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { KnifePhoto } from '@/components/lumen/knife-photo'
import type { Knife } from '@/lib/data'
import { matchesLumenSearch } from '@/lib/lumen-collection'

const navLinks = [
  { href: '/collection', label: 'Home' },
  { href: '/collection?all=1', label: 'All knives' },
  { href: '/insights', label: 'Insights' },
  { href: '/studio', label: 'Studio' },
  { href: '/compare', label: 'Compare' },
  { href: '/logs', label: 'History' },
] as const

type PaletteAction = {
  label: string
  hint?: string
  run: () => void
}

/** Link to a knife's focus view on the Shelf home. */
function shelfFocusHref(id: string) {
  return `/collection?focus=${encodeURIComponent(id)}`
}

/**
 * Shelf: an editorial layout. A masthead with text navigation, a command
 * palette (⌘K) for search and actions, and full-width pages below.
 */
export function ShelfShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  const { isAutoBackupActive } = useKnives()
  const { active } = useComparisons()
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const isAll = pathname === '/collection' && params.get('all') === '1'
  const compareCount = active?.ids.length ?? 0

  useEffect(() => {
    const open = () => setIsPaletteOpen(true)
    const handleKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        setIsPaletteOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', handleKey)
    window.addEventListener(OPEN_GLOBAL_SEARCH_EVENT, open)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener(OPEN_GLOBAL_SEARCH_EVENT, open)
    }
  }, [])

  const actions: PaletteAction[] = [
    { label: 'Add knife', run: () => router.push('/add') },
    { label: 'Import from URLs', run: () => setIsImportOpen(true) },
    { label: 'Browse all knives', run: () => router.push('/collection?all=1') },
    { label: 'Open Insights', run: () => router.push('/insights') },
    { label: 'Open Studio', run: () => router.push('/studio') },
    {
      label: 'Open Compare',
      hint: compareCount ? `${compareCount} in comparison` : undefined,
      run: () => router.push('/compare'),
    },
    { label: 'Open History', run: () => router.push('/logs') },
    {
      label: 'Cloud backup settings',
      hint: isAutoBackupActive ? 'Auto backup on' : 'Auto backup off',
      run: () => router.push('/settings?tab=cloud-backup'),
    },
    { label: 'Settings', run: () => router.push('/settings') },
  ]

  return (
    <div data-modern-shell data-lumen-shell="shelf">
      <a href="#shelf-content" data-shelf-skip>
        Skip to content
      </a>
      <div data-workspace-body>
        <main id="shelf-content" tabIndex={-1}>
          <header data-shelf-mast>
            <Link
              href="/collection"
              data-shelf-logo
              aria-label="BladeVault home"
            >
              <i aria-hidden="true" />
              BladeVault
            </Link>
            <nav aria-label="Main navigation" data-shelf-nav>
              {navLinks.map(({ href, label }) => {
                const selected =
                  href === '/collection'
                    ? pathname === '/collection' && !isAll
                    : href === '/collection?all=1'
                      ? isAll || pathname.startsWith('/collection/')
                      : pathname === href || pathname.startsWith(href + '/')
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={selected ? 'page' : undefined}
                  >
                    {label}
                    {href === '/compare' && compareCount > 0 && (
                      <small aria-label={`${compareCount} in comparison`}>
                        {compareCount}
                      </small>
                    )}
                  </Link>
                )
              })}
            </nav>
            <div data-shelf-mast-actions>
              {pathname === '/studio' && (
                <span id="studio-header-actions" ref={setHeaderActions} />
              )}
              <button
                type="button"
                data-shelf-cmd
                onClick={() => setIsPaletteOpen(true)}
                aria-keyshortcuts="Meta+K Control+K"
              >
                <Search aria-hidden="true" />
                <span>Search or jump to…</span>
                <kbd aria-hidden="true">⌘K</kbd>
              </button>
              <Link
                href="/settings"
                data-shelf-icon-button
                aria-label="Settings"
                aria-current={pathname === '/settings' ? 'page' : undefined}
              >
                <Settings aria-hidden="true" />
              </Link>
              <Link href="/add" data-shelf-add>
                Add knife
              </Link>
            </div>
          </header>
          <WorkspaceHeaderActionsContext.Provider value={headerActions}>
            {children}
          </WorkspaceHeaderActionsContext.Provider>
        </main>
      </div>
      <ShelfPalette
        open={isPaletteOpen}
        onOpenChange={setIsPaletteOpen}
        actions={actions}
        onOpenKnife={(knife) => router.push(shelfFocusHref(knife.id))}
      />
      <BatchScrapeDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  )
}

function ShelfPalette({
  open,
  onOpenChange,
  actions,
  onOpenKnife,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: PaletteAction[]
  onOpenKnife: (knife: Knife) => void
}) {
  const { knives } = useKnives()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const matches = useMemo(() => {
    const value = query.trim()
    const found = value
      ? knives.filter((knife) => matchesLumenSearch(knife, value))
      : [...knives].sort(
          (a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt),
        )
    return found.slice(0, 6)
  }, [knives, query])
  const commands = actions.filter((action) =>
    action.label.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const items = [
    ...matches.map((knife) => ({ kind: 'knife' as const, knife })),
    ...commands.map((action) => ({ kind: 'action' as const, action })),
  ]
  const activeIndex = Math.min(active, Math.max(0, items.length - 1))

  const close = () => {
    onOpenChange(false)
    setQuery('')
    setActive(0)
  }
  const run = (index: number) => {
    const item = items[index]
    if (!item) return
    close()
    if (item.kind === 'knife') onOpenKnife(item.knife)
    else item.action.run()
  }

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  let index = 0
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-shelf-pal-scrim />
        <Dialog.Popup data-shelf-pal aria-label="Search and commands">
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive(
                  Math.max(
                    0,
                    Math.min(
                      items.length - 1,
                      activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
                    ),
                  ),
                )
              } else if (event.key === 'Enter') {
                event.preventDefault()
                run(activeIndex)
              }
            }}
            placeholder="Search knives, run a command…"
            role="combobox"
            aria-expanded="true"
            aria-controls="shelf-palette-list"
            aria-activedescendant={
              items.length ? `shelf-palette-${activeIndex}` : undefined
            }
            aria-autocomplete="list"
          />
          <ul id="shelf-palette-list" role="listbox" ref={listRef}>
            {matches.length > 0 && (
              <li role="presentation" data-shelf-pal-section>
                {query.trim() ? 'Knives' : 'Recently added'}
              </li>
            )}
            {matches.map((knife) => {
              const itemIndex = index++
              return (
                <li
                  key={knife.id}
                  id={`shelf-palette-${itemIndex}`}
                  role="option"
                  aria-selected={itemIndex === activeIndex}
                  data-index={itemIndex}
                  data-shelf-pal-item
                  onMouseMove={() => setActive(itemIndex)}
                  onClick={() => run(itemIndex)}
                >
                  <span data-shelf-pal-icon>
                    <KnifePhoto knife={knife} sizes="40px" />
                  </span>
                  <span data-shelf-pal-label>{knife.name}</span>
                  <small>
                    {[knife.brand, knife.specs.bladeMaterial]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </li>
              )
            })}
            {commands.length > 0 && (
              <li role="presentation" data-shelf-pal-section>
                Actions
              </li>
            )}
            {commands.map((action) => {
              const itemIndex = index++
              return (
                <li
                  key={action.label}
                  id={`shelf-palette-${itemIndex}`}
                  role="option"
                  aria-selected={itemIndex === activeIndex}
                  data-index={itemIndex}
                  data-shelf-pal-item
                  onMouseMove={() => setActive(itemIndex)}
                  onClick={() => run(itemIndex)}
                >
                  <span data-shelf-pal-icon>
                    <ArrowRight aria-hidden="true" />
                  </span>
                  <span data-shelf-pal-label>{action.label}</span>
                  {action.hint && <small>{action.hint}</small>}
                </li>
              )
            })}
            {items.length === 0 && (
              <li role="presentation" data-shelf-pal-section>
                No matches
              </li>
            )}
          </ul>
          <footer data-shelf-pal-foot aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate
            </span>
            <span>
              <kbd>↵</kbd> open
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
