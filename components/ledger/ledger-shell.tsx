'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, Settings } from 'lucide-react'
import { BrandMark } from '@/components/brand-mark'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { BatchScrapeDialog } from '@/components/batch-scrape-dialog'
import { ThemeCycleButton } from '@/components/theme-cycle-button'
import { ThemeModeButton } from '@/components/theme-mode-button'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import { useKnives } from '@/components/providers/knives-provider'
import { useComparisons } from '@/components/providers/comparisons-provider'

const tabs = [
  { href: '/insights', label: 'Insights' },
  { href: '/collection', label: 'Collection' },
  { href: '/studio', label: 'Studio' },
  { href: '/compare', label: 'Compare' },
  { href: '/logs', label: 'History' },
] as const

export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || Boolean(target.closest('[role="dialog"]'))))
  )
}

/**
 * Ledger: a dense, keyboard-friendly layout styled like a bound account book.
 * A cloth-green header carries the navigation as index tabs; pages fill the
 * ruled paper below without a sidebar.
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

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'n' ||
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
          {tabs.map(({ href, label }) => {
            const selected =
              pathname === href || pathname.startsWith(href + '/')
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
            href="/settings?tab=cloud-backup"
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
            {isLoading
              ? 'Local vault · loading'
              : isAutoBackupActive
                ? 'Local vault · backed up'
                : 'Local vault · saved'}
          </Link>
          <ThemeModeButton data-ledger-button="icon" />
          <ThemeCycleButton data-ledger-button="icon" />
          <Link
            href="/settings"
            data-ledger-button="ghost"
            aria-current={pathname === '/settings' ? 'page' : undefined}
            aria-label="Settings"
          >
            <Settings aria-hidden="true" data-ledger-narrow-only />
            <span data-ledger-wide-only>Settings</span>
          </Link>
          <button
            type="button"
            data-ledger-button
            data-ledger-wide-only
            onClick={() => setIsImportOpen(true)}
          >
            Import
          </button>
          <Link href="/add" data-ledger-button="primary">
            <Plus aria-hidden="true" />
            <span data-ledger-wide-only>New knife</span>
            <kbd data-ledger-wide-only aria-hidden="true">
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
      <BatchScrapeDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  )
}
