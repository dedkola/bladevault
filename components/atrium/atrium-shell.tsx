'use client'

import {
  WishlistSaleBadge,
  formatNavCount,
  useWishlistNavCounts,
  wishlistCountLabel,
} from '@/components/wishlist/wishlist-nav-count'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  GalleryVertical,
  History,
  TrendingDown,
  Heart,
  Wrench,
  LayoutDashboard,
  Library,
  Plus,
  Search,
} from 'lucide-react'
import { BrandMark } from '@/components/brand-mark'
import { CompareIcon } from '@/components/icons/compare-icon'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { WorkspaceFooter } from '@/components/workspace-footer'
import { BatchScrapeDialog } from '@/components/batch-scrape-dialog'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { useLumenCollection } from '@/components/lumen/use-lumen-collection'
import { hasServerRuntime } from '@/lib/runtime-capabilities'

const dockLinks = [
  { href: '/insights', label: 'Insights', icon: LayoutDashboard },
  { href: '/collection', label: 'Collection', icon: Library },
  { href: '/studio', label: 'Studio', icon: GalleryVertical },
  { href: '/compare', label: 'Compare', icon: CompareIcon },
  { href: '/wishlist', label: 'Wishlist', icon: Heart },
  { href: '/price-drops', label: 'Price Drops', icon: TrendingDown },
  { href: '/maintenance', label: 'Maintenance', icon: Wrench },
  { href: '/logs', label: 'History', icon: History },
] as const

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/** The collection filter field shown in the top bar on the Collection page. */
function CollectionSearchField() {
  const { query, setQuery } = useLumenCollection()
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || isEditable(event.target)) return
      event.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])
  return (
    <label data-atrium-search>
      <Search aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        placeholder="Search knives, steels, brands…"
        aria-label="Search the collection"
      />
      <span data-lumen-kbd aria-hidden="true">
        /
      </span>
    </label>
  )
}

/**
 * Atrium: a gallery-first layout with no sidebar. A slim top bar carries the
 * brand, search and main actions; a floating dock above the shared footer
 * switches between the workspace pages.
 */
export function AtriumShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { active } = useComparisons()
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const isCollection = pathname === '/collection'
  const isStudio = pathname === '/studio'
  const compareCount = active?.ids.length ?? 0
  const wishlist = useWishlistNavCounts()

  return (
    <div data-modern-shell data-lumen-shell="atrium">
      <a href="#atrium-content" data-atrium-skip>
        Skip to content
      </a>
      <header data-atrium-top data-scrolled={scrolled || undefined}>
        <Link href="/collection" data-atrium-brand aria-label="BladeVault">
          <span data-atrium-logo>
            <BrandMark />
          </span>
          <b>BladeVault</b>
        </Link>
        <div data-atrium-search-slot>
          {isCollection ? (
            <CollectionSearchField />
          ) : isStudio ? null : (
            <div data-atrium-global-search>
              <GlobalKnifeSearch embedded />
            </div>
          )}
        </div>
        <div data-atrium-actions>
          {isStudio && (
            <span id="studio-header-actions" ref={setHeaderActions} />
          )}
          <button
            type="button"
            data-atrium-button
            data-atrium-import
            onClick={() => setIsImportOpen(true)}
          >
            Import
          </button>
          <Link href="/add" data-atrium-button="primary">
            <Plus aria-hidden="true" />
            <span>Add knife</span>
          </Link>
        </div>
      </header>
      <div data-workspace-body>
        <main
          id="atrium-content"
          tabIndex={-1}
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}
        >
          <WorkspaceHeaderActionsContext.Provider value={headerActions}>
            {children}
          </WorkspaceHeaderActionsContext.Provider>
        </main>
      </div>
      <WorkspaceFooter />
      <nav aria-label="Main navigation" data-atrium-dock>
        {dockLinks
          .filter(
            ({ href }) =>
              (href !== '/price-drops' && href !== '/wishlist') ||
              hasServerRuntime(),
          )
          .map(({ href, label, icon: Icon }) => {
            const selected =
              pathname === href || pathname.startsWith(href + '/')
            return (
              <Link
                key={href}
                href={href}
                aria-current={selected ? 'page' : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
                {href === '/wishlist' && wishlist.total > 0 && (
                  <>
                    <span className="sr-only">
                      {wishlistCountLabel(wishlist.total, wishlist.onSale)}
                    </span>
                    {wishlist.onSale > 0 && (
                      <WishlistSaleBadge count={wishlist.onSale} />
                    )}
                    <small data-atrium-dock-count aria-hidden="true">
                      {formatNavCount(wishlist.total)}
                    </small>
                  </>
                )}
                {href === '/compare' && compareCount > 0 && (
                  <small
                    data-atrium-dock-count
                    aria-label={`${compareCount} in comparison`}
                  >
                    {compareCount}
                  </small>
                )}
              </Link>
            )
          })}
        <Link
          href="/add"
          data-atrium-dock-extra
          aria-current={pathname === '/add' ? 'page' : undefined}
        >
          <Plus aria-hidden="true" />
          <span>Add</span>
        </Link>
      </nav>
      <BatchScrapeDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  )
}
