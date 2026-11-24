'use client'

import {
  WishlistSaleBadge,
  formatNavCount,
  useWishlistNavCounts,
  wishlistCountLabel,
} from '@/components/wishlist/wishlist-nav-count'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { BrandMark } from '@/components/brand-mark'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { BatchScrapeDialog } from '@/components/batch-scrape-dialog'
import { WorkspaceFooter } from '@/components/workspace-footer'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import { useKnives } from '@/components/providers/knives-provider'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { hasServerRuntime } from '@/lib/runtime-capabilities'

const tabs = [
  { href: '/insights', label: 'Insights' },
  { href: '/collection', label: 'Collection' },
  { href: '/studio', label: 'Studio' },
  { href: '/compare', label: 'Compare' },
  { href: '/wishlist', label: 'Wishlist' },
  { href: '/price-drops', label: 'Price Drops' },
  { href: '/maintenance', label: 'Maintenance' },
  { href: '/logs', label: 'History' },
] as const

/** Keys typed here belong to the field, dialog or open menu, not to Ledger. */
export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement &&
      (target.isContentEditable ||
        Boolean(
          target.closest('[role="dialog"], [role="menu"], [role="listbox"]'),
        )))
  )
}

/**
 * Ledger: a dense, keyboard-friendly layout styled like a bound account book.
 * A cloth-green header carries the navigation as index tabs; pages fill the
 * ruled paper below without a sidebar, above the shared workspace footer,
 * which carries the theme switcher.
 */
export function LedgerShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { isAutoBackupActive, isLoading } = useKnives()
  const { active } = useComparisons()
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const showSearch = pathname !== '/collection' && pathname !== '/studio'
  const compareCount = active?.ids.length ?? 0
  const wishlist = useWishlistNavCounts()

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'n' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      )
        return
      event.preventDefault()
      router.push('/add')
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [router])

  return (
    <div data-modern-shell data-lumen-shell="ledger">
      <a href="#ledger-content" data-ledger-skip>
        Skip to content
      </a>
      <header data-ledger-head>
        <Link href="/collection" data-ledger-brand aria-label="BladeVault">
          <span data-ledger-logo>
            <BrandMark />
          </span>
          <span data-ledger-wordmark>
            <b>BladeVault</b>
            <small>Ledger</small>
          </span>
        </Link>
        <nav aria-label="Main navigation" data-ledger-tabs>
          {tabs
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
                      <small aria-hidden="true">
                        {formatNavCount(wishlist.total)}
                      </small>
                    </>
                  )}
                  {href === '/compare' && compareCount > 0 && (
                    <small>
                      {compareCount}
                      <span className="sr-only"> in comparison</span>
                    </small>
                  )}
                </Link>
              )
            })}
        </nav>
        <div data-ledger-head-right>
          {showSearch && (
            <div data-ledger-search>
              <GlobalKnifeSearch embedded />
            </div>
          )}
          {pathname === '/studio' && (
            <span id="studio-header-actions" ref={setHeaderActions} />
          )}
          <Link
            href="/settings?tab=backup"
            data-ledger-vault
            data-backup={isAutoBackupActive ? 'on' : 'off'}
            title={
              isAutoBackupActive
                ? 'Cloud auto backup is active'
                : 'Cloud auto backup is inactive'
            }
            onClick={() =>
              window.dispatchEvent(
                new Event('bladevault:open-cloud-backup-settings'),
              )
            }
          >
            <span data-ledger-vault-text>
              {isLoading
                ? 'Local vault · loading'
                : isAutoBackupActive
                  ? 'Local vault · backed up'
                  : 'Local vault · saved'}
            </span>
          </Link>
          <button
            type="button"
            data-ledger-button
            data-ledger-import
            onClick={() => setIsImportOpen(true)}
          >
            Import
          </button>
          <Link
            href="/add"
            data-ledger-button="primary"
            aria-label="New knife"
            aria-keyshortcuts="N"
          >
            <Plus aria-hidden="true" />
            <span data-ledger-wide-only>New knife</span>
            <kbd data-ledger-roomy-only aria-hidden="true">
              N
            </kbd>
          </Link>
        </div>
      </header>
      <div data-workspace-body>
        <main id="ledger-content" tabIndex={-1}>
          <WorkspaceHeaderActionsContext.Provider value={headerActions}>
            {children}
          </WorkspaceHeaderActionsContext.Provider>
        </main>
      </div>
      <WorkspaceFooter />
      <BatchScrapeDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  )
}
