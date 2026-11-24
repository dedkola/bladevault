'use client'

import {
  WishlistSaleBadge,
  formatNavCount,
  useWishlistNavCounts,
  wishlistCountLabel,
} from '@/components/wishlist/wishlist-nav-count'
import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Menu } from '@base-ui/react/menu'
import {
  Bookmark,
  ChevronDown,
  Moon,
  Pin,
  Plus,
  Sun,
} from 'lucide-react'
import Image from '@/components/vault-image'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { useKnives } from '@/components/providers/knives-provider'
import { useCare } from '@/components/providers/care-provider'
import { useMarketFilter } from '@/components/providers/market-provider'
import { useSmartCollections } from '@/components/providers/smart-collections-provider'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { WorkspaceFooter } from '@/components/workspace-footer'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import { readJsonResponse } from '@/lib/api-response'
import { matchesCollection } from '@/lib/smart-collections'
import { SETTINGS_UPDATED_EVENT, type AppSettings } from '@/lib/settings-shared'
import { hasServerRuntime } from '@/lib/runtime-capabilities'

const links = [
  { href: '/collection', label: 'Collection' },
  { href: '/studio', label: 'Studio' },
  { href: '/insights', label: 'Insights' },
  { href: '/compare', label: 'Compare' },
  { href: '/wishlist', label: 'Wishlist' },
  { href: '/price-drops', label: 'Price Drops' },
  { href: '/maintenance', label: 'Maintenance' },
  { href: '/logs', label: 'History' },
] as const

export function AlloyShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const wishlist = useWishlistNavCounts()
  const params = useSearchParams()
  const { knives, showFeedback } = useKnives()
  const { reminders: careReminders, statusById: careStatusById } = useCare()
  const careStatusFilter = careReminders.enabled ? careStatusById : undefined
  const marketFilter = useMarketFilter()
  const { active } = useComparisons()
  const { collections, error: collectionsError } = useSmartCollections()
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null)
  const [savingAppearance, setSavingAppearance] = useState(false)
  // Studio and Collection render their own search fields.
  const showHeaderSearch = pathname !== '/studio' && pathname !== '/collection'
  const pinnedCount = knives.filter((knife) => knife.pinned).length
  const brands = [
    ...new Set(knives.map((knife) => knife.brand).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b))
  const menuClass = 'alloy-library-menu'

  async function toggleAppearance() {
    const root = document.documentElement
    const wasDark = root.classList.contains('dark')
    const theme = wasDark ? 'light' : 'dark'
    root.classList.toggle('dark', !wasDark)
    setSavingAppearance(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      })
      const data = await readJsonResponse<{ error?: string }>(response)
      if (!response.ok) {
        throw new Error(data.error || 'Could not save appearance.')
      }
      window.dispatchEvent(
        new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
          detail: { theme },
        }),
      )
    } catch {
      root.classList.toggle('dark', wasDark)
      showFeedback('Could not save the appearance preference.', 'error')
    } finally {
      setSavingAppearance(false)
    }
  }

  return (
    <div data-alloy-shell>
      <a href="#alloy-content" className="alloy-skip-link">
        Skip to content
      </a>
      <header data-alloy-header>
        <Link href="/collection" data-alloy-brand aria-label="BladeVault home">
          <Image src="/logo.svg" alt="" width={26} height={28} unoptimized />
          <b>BladeVault</b>
          <span>Alloy</span>
        </Link>
        <nav aria-label="Main navigation" data-alloy-nav>
          {links
            .filter(
              ({ href }) =>
                (href !== '/price-drops' && href !== '/wishlist') ||
                hasServerRuntime(),
            )
            .map(({ href, label }) => {
              const selected =
                pathname === href || pathname.startsWith(href + '/')
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={selected ? 'page' : undefined}
                >
                  {label}
                  {href === '/wishlist' && wishlist.total > 0 && (
                    <>
                      <span className="sr-only">
                        {wishlistCountLabel(wishlist.total, wishlist.onSale)}
                      </span>
                      {wishlist.onSale > 0 && (
                        <WishlistSaleBadge count={wishlist.onSale} />
                      )}
                      <span data-alloy-nav-count aria-hidden="true">
                        {formatNavCount(wishlist.total)}
                      </span>
                    </>
                  )}
                  {href === '/compare' && Boolean(active?.ids.length) && (
                    <span data-alloy-nav-count aria-hidden="true">
                      {active?.ids.length}
                    </span>
                  )}
                </Link>
              )
            })}
        </nav>
        <div data-alloy-utilities>
          {showHeaderSearch && (
            <div data-alloy-global-search>
              <GlobalKnifeSearch embedded />
            </div>
          )}
          <button
            type="button"
            onClick={() => void toggleAppearance()}
            disabled={savingAppearance}
            aria-label="Toggle workspace appearance"
          >
            <Moon className="dark:hidden" />
            <Sun className="hidden dark:block" />
          </button>
          <Link href="/add" data-alloy-add aria-label="Add knife">
            <Plus />
            <span>Add knife</span>
          </Link>
        </div>
      </header>

      <div data-alloy-library>
        <span data-alloy-library-label>Personal archive</span>
        <Link
          href="/collection"
          aria-current={
            pathname === '/collection' && !params.toString()
              ? 'page'
              : undefined
          }
        >
          All knives
        </Link>
        <Link
          href="/collection?view=pinned"
          aria-current={
            pathname === '/collection' && params.get('view') === 'pinned'
              ? 'page'
              : undefined
          }
        >
          <Pin />
          Pinned <span>{pinnedCount}</span>
        </Link>
        <Menu.Root>
          <Menu.Trigger>
            <Bookmark />
            Saved collections
            <ChevronDown />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              align="start"
              sideOffset={8}
              className="isolate z-50"
            >
              <Menu.Popup className={menuClass}>
                {collectionsError && <p role="alert">{collectionsError}</p>}
                {!collectionsError && collections.length === 0 && (
                  <p>Save a filtered view from Collection to see it here.</p>
                )}
                {collections.map((collection) => (
                  <Menu.Item
                    key={collection.id}
                    render={
                      <Link
                        href={`/collection?${collection.query}&smart=${encodeURIComponent(collection.id)}`}
                      />
                    }
                  >
                    <span>{collection.name}</span>
                    <small>
                      {
                        knives.filter((knife) =>
                          matchesCollection(
                            knife,
                            new URLSearchParams(collection.query),
                            careStatusFilter,
                            marketFilter,
                          ),
                        ).length
                      }
                    </small>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <Menu.Root>
          <Menu.Trigger>
            By maker
            <ChevronDown />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              align="start"
              sideOffset={8}
              className="isolate z-50"
            >
              <Menu.Popup className={menuClass}>
                {brands.length === 0 && (
                  <p>Your makers will appear as you add knives.</p>
                )}
                {brands.map((brand) => (
                  <Menu.Item
                    key={brand}
                    render={
                      <Link
                        href={`/collection?brand=${encodeURIComponent(brand)}`}
                      />
                    }
                  >
                    <span>{brand}</span>
                    <small>
                      {knives.filter((knife) => knife.brand === brand).length}
                    </small>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {pathname === '/studio' && (
          <span id="studio-header-actions" ref={setHeaderActions} />
        )}
      </div>
      <main id="alloy-content" tabIndex={-1} data-alloy-content>
        <WorkspaceHeaderActionsContext.Provider value={headerActions}>
          {children}
        </WorkspaceHeaderActionsContext.Provider>
      </main>
      <WorkspaceFooter />
    </div>
  )
}
