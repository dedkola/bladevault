'use client'

import Link from 'next/link'
import Image from '@/components/vault-image'
import { usePathname } from 'next/navigation'
import {
  Cloud,
  CloudOff,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
} from 'lucide-react'
import { SidebarShell } from '@/components/sidebar-shell'
import {
  GlobalKnifeSearch,
  OPEN_GLOBAL_SEARCH_EVENT,
} from '@/components/global-knife-search'
import { useKnives } from '@/components/providers/knives-provider'
import { readJsonResponse } from '@/lib/api-response'
import { SETTINGS_UPDATED_EVENT, type AppSettings } from '@/lib/settings-shared'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { themeStyle, knives, isLoading, isAutoBackupActive, showFeedback } =
    useKnives()
  if (themeStyle !== 'modern') {
    return (
      <>
        <SidebarShell />
        <main tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
          {children}
        </main>
      </>
    )
  }
  const crumb = pathname.startsWith('/compare')
    ? ['Compare', 'Saved comparisons']
    : pathname.startsWith('/logs')
      ? ['Activity', 'Logs']
      : pathname === '/studio'
        ? ['Studio', 'Visual library']
        : pathname === '/collection'
          ? ['Collection', 'All objects']
          : pathname.startsWith('/collection/')
            ? ['Collection', 'Object details']
            : pathname.startsWith('/settings')
              ? ['Workspace', 'Settings']
              : pathname.startsWith('/add')
                ? ['Collection', 'Add knife']
                : ['Workspace', 'Insights']
  async function toggleTheme() {
    const root = document.documentElement
    const dark = !root.classList.contains('dark')
    root.classList.toggle('dark', dark)
    try {
      const theme = dark ? 'dark' : 'light'
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      })
      const data = await readJsonResponse<{ error?: string }>(response)
      if (!response.ok)
        throw new Error(data.error || 'Failed to save theme preference')
      window.dispatchEvent(
        new CustomEvent<Partial<AppSettings>>(SETTINGS_UPDATED_EVENT, {
          detail: { theme },
        }),
      )
    } catch {
      root.classList.toggle('dark', !dark)
      showFeedback('Could not save the appearance preference.', 'error')
    }
  }
  return (
    <div data-modern-shell>
      <header data-workspace-header>
        <Link
          href="/collection"
          data-workspace-brand
          aria-label="BladeVault workspace"
        >
          <span data-workspace-logo>
            <Image src="/logo.svg" alt="" width={26} height={26} unoptimized />
          </span>
          <b>BladeVault</b>
          <span>/ Workspace</span>
        </Link>
        <nav aria-label="Breadcrumb" data-workspace-crumb>
          <span>{crumb[0]}</span>
          <span aria-hidden="true">/</span>
          <b>{crumb[1]}</b>
        </nav>
        <div data-workspace-search>
          <GlobalKnifeSearch embedded />
        </div>
        <div data-workspace-actions>
          <Link
            href="/settings?tab=cloud-backup"
            aria-label="Cloud backup"
            title={
              isAutoBackupActive
                ? 'Cloud auto backup is active. Open Cloud backup settings.'
                : 'Cloud auto backup is inactive. Open Cloud backup settings.'
            }
            onClick={() =>
              window.dispatchEvent(
                new Event('bladevault:open-cloud-backup-settings'),
              )
            }
          >
            {isAutoBackupActive ? (
              <Cloud className="text-primary" />
            ) : (
              <CloudOff />
            )}
          </Link>
          <Link href="/settings" aria-label="Workspace settings">
            <Settings />
          </Link>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle workspace appearance"
          >
            <Moon className="dark:hidden" />
            <Sun className="hidden dark:block" />
          </button>
          <Link href="/add" data-workspace-add>
            <Plus />
            Add knife
          </Link>
        </div>
      </header>
      <div data-workspace-body>
        <SidebarShell />
        <main tabIndex={-1}>{children}</main>
      </div>
      <footer data-workspace-footer>
        <div>
          <span>
            {isLoading ? 'Loading collection…' : `${knives.length} objects`}
          </span>
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new Event(OPEN_GLOBAL_SEARCH_EVENT))
            }
          >
            <kbd>⌘K</kbd>
            <Search />
            Search
          </button>
        </div>
      </footer>
    </div>
  )
}
