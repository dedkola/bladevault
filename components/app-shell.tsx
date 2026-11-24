'use client'

import { useState } from 'react'
import Link from 'next/link'
import { WorkspaceHeaderActionsContext } from '@/components/workspace-header-actions'
import Image from '@/components/vault-image'
import { usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import { SidebarShell } from '@/components/sidebar-shell'
import { AlloyShell } from '@/components/alloy-shell'
import { AtriumShell } from '@/components/atrium/atrium-shell'
import { ShelfShell } from '@/components/shelf/shelf-shell'
import { LedgerShell } from '@/components/ledger/ledger-shell'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { WorkspaceFooter } from '@/components/workspace-footer'
import { useKnives } from '@/components/providers/knives-provider'
import { BrandMark } from '@/components/brand-mark'
import { THEME_STYLE_NAMES, isModernThemeFamily } from '@/lib/settings-shared'
import { workspaceCrumb } from '@/lib/workspace-crumb'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null)
  const { themeStyle } = useKnives()
  if (themeStyle === 'alloy') {
    return <AlloyShell>{children}</AlloyShell>
  }
  if (themeStyle === 'atrium') {
    return <AtriumShell>{children}</AtriumShell>
  }
  if (themeStyle === 'shelf') {
    return <ShelfShell>{children}</ShelfShell>
  }
  if (themeStyle === 'ledger') {
    return <LedgerShell>{children}</LedgerShell>
  }
  if (!isModernThemeFamily(themeStyle)) {
    return (
      <div data-classic-shell>
        <div data-classic-body>
          <SidebarShell />
          <main tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
            {children}
          </main>
        </div>
        <WorkspaceFooter />
      </div>
    )
  }
  // Studio and Collection render their own search fields.
  const showWorkspaceSearch =
    pathname !== '/studio' && pathname !== '/collection'
  const crumb = workspaceCrumb(pathname)
  return (
    <div data-modern-shell>
      <header data-workspace-header>
        <Link href="/collection" data-workspace-brand aria-label="BladeVault">
          <span data-workspace-logo>
            <Image src="/logo.svg" alt="" width={26} height={26} unoptimized />
            <BrandMark />
          </span>
          <span data-workspace-wordmark>
            <b>BladeVault</b>
            <small data-workspace-theme-name>
              {THEME_STYLE_NAMES[themeStyle]}
            </small>
          </span>
        </Link>
        <nav aria-label="Breadcrumb" data-workspace-crumb>
          <span>{crumb[0]}</span>
          <span aria-hidden="true">/</span>
          <b>{crumb[1]}</b>
        </nav>
        {showWorkspaceSearch && (
          <div data-workspace-search>
            <GlobalKnifeSearch embedded />
          </div>
        )}
        <div data-workspace-actions>
          {pathname === '/studio' && (
            <span id="studio-header-actions" ref={setHeaderActions} />
          )}
          <Link href="/add" data-workspace-add>
            <Plus />
            Add knife
          </Link>
        </div>
      </header>
      <div data-workspace-body>
        <SidebarShell />
        <main tabIndex={-1}>
          <WorkspaceHeaderActionsContext.Provider value={headerActions}>
            {children}
          </WorkspaceHeaderActionsContext.Provider>
        </main>
      </div>
      <WorkspaceFooter />
    </div>
  )
}
