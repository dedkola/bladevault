'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useSearchParams } from 'next/navigation'
import { useMemo, useState } from 'react'
import {
  LayoutDashboard,
  Library,
  Scale,
  PlusCircle,
  Settings,
  Sun,
  Moon,
  ChevronRight,
  Cloud,
  CloudOff,
  Download,
  Loader2,
  Menu,
  Pin,
  ScrollText,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { readJsonResponse } from '@/lib/api-response'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { type AppSettings } from '@/lib/settings-shared'
import { useDesktopUpdates } from '@/hooks/use-desktop-updates'

const links = [
  { href: '/', label: 'Insights', icon: LayoutDashboard },
  { href: '/collection', label: 'Collection', icon: Library },
  { href: '/compare', label: 'Compare', icon: Scale },
]

export function Sidebar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchParamsKey = searchParams.toString()
  const selectedBrands = searchParams.getAll('brand')
  const routeKey = searchParamsKey ? `${pathname}?${searchParamsKey}` : pathname
  const { knives, compareIds, isAutoBackupActive } = useKnives()
  const { update, downloadUpdate } = useDesktopUpdates()
  const [brandsOpen, setBrandsOpen] = useState(true)
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [mobileNavSession, setMobileNavSession] = useState<string | null>(null)
  const isMobileNavOpen = mobileNavSession === routeKey
  const isSettingsActive = pathname === '/settings'
  const isCloudBackupSettingsActive =
    isSettingsActive && searchParams.get('tab') === 'cloud-backup'
  const hasUpdate = update.status === 'available'
  const isUpdateBusy =
    update.status === 'checking' || update.status === 'downloading'

  const handleUpdateClick = async () => {
    if (hasUpdate) await downloadUpdate()
  }

  const brands = useMemo(() => {
    const counts = new Map<string, number>()

    knives.forEach((knife) => {
      counts.set(knife.brand, (counts.get(knife.brand) ?? 0) + 1)
    })

    return Array.from(counts.entries())
      .sort(([brandA], [brandB]) => brandA.localeCompare(brandB))
      .map(([name, count]) => ({ name, count }))
  }, [knives])

  const pinnedKnives = useMemo(
    () => knives.filter((knife) => knife.pinned),
    [knives],
  )

  const toggleTheme = async () => {
    const root = document.documentElement
    const nextIsDark = !root.classList.contains('dark')

    root.classList.toggle('dark', nextIsDark)

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: nextIsDark ? 'dark' : 'light',
        } satisfies Pick<AppSettings, 'theme'>),
      })

      const data = await readJsonResponse<{ error?: string }>(response)
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save theme preference')
      }
    } catch (error) {
      root.classList.toggle('dark', !nextIsDark)
      console.error('Failed to save theme preference', error)
    }
  }

  const closeMobileNav = () => {
    setMobileNavSession(null)
  }

  const renderSidebarContent = (isMobile: boolean) => {
    const handleNavigate = isMobile ? closeMobileNav : undefined
    const handleOpenCloudBackup = () => {
      window.dispatchEvent(new Event('bladevault:open-cloud-backup-settings'))
      handleNavigate?.()
    }

    return (
      <aside
        className={cn(
          'flex min-h-0 flex-col bg-sidebar text-sidebar-foreground print:hidden',
          isMobile
            ? 'h-dvh max-h-dvh w-[min(20rem,calc(100vw-2.5rem))] max-w-full border-r border-sidebar-border shadow-2xl'
            : 'hidden h-full w-60 shrink-0 border-r border-sidebar-border md:flex',
        )}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <Link
            href="/"
            onClick={handleNavigate}
            className="flex min-w-0 items-center gap-2.5"
          >
            <div className="relative h-12 w-12 shrink-0">
              <Image
                src="/logo.svg"
                alt="BladeVault logo"
                fill
                sizes="48px"
                unoptimized
                className="object-contain p-1"
                priority
              />
            </div>
            <span className="truncate text-2xl font-semibold tracking-tight text-foreground">
              <span>Blade</span>
              <span style={{ color: 'var(--bladevault-title)' }}>Vault</span>
            </span>
          </Link>

          {isMobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={closeMobileNav}
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="px-4 pb-2">
          <Button
            size="sm"
            className="w-full"
            render={<Link href="/add" onClick={handleNavigate} />}
            nativeButton={false}
          >
            <PlusCircle className="h-3.5 w-3.5" />
            Add Knife
          </Button>
        </div>

        {hasUpdate || isUpdateBusy ? (
          <div className="flex justify-center px-4 pb-2">
            <button
              type="button"
              onClick={handleUpdateClick}
              disabled={isUpdateBusy}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[9px] font-semibold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)]/60',
                'border-[var(--bladevault-gold)]/70 bg-[var(--bladevault-gold)]/15 text-[var(--bladevault-title)] hover:bg-[var(--bladevault-gold)]/25 dark:text-[var(--bladevault-gold)]',
              )}
              title={
                hasUpdate
                  ? `Download BladeVault ${update.version}`
                  : 'Checking for BladeVault updates'
              }
            >
              {isUpdateBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {hasUpdate ? 'Update' : 'Checking'}
            </button>
          </div>
        ) : null}

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2">
          <div className="px-2 pb-1.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--bladevault-title)]">
            Main
          </div>
          {links.map((link) => {
            const Icon = link.icon
            const isActive =
              pathname === link.href ||
              (link.href !== '/' && pathname.startsWith(link.href)) ||
              (link.href === '/' && pathname === '/logs')
            const isLogsActive = pathname === '/logs'

            return (
              <div key={link.href} className="space-y-0.5">
                <Link
                  href={link.href}
                  onClick={handleNavigate}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)]'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex flex-1 items-center justify-between gap-2">
                    <span>{link.label}</span>
                    {(link.href === '/collection' && knives.length > 0) ||
                    (link.href === '/compare' && compareIds.length > 0) ? (
                      <span
                        className={cn(
                          'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                          isActive
                            ? 'bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)]'
                            : 'bg-muted text-foreground',
                        )}
                      >
                        {link.href === '/collection'
                          ? knives.length
                          : compareIds.length}
                      </span>
                    ) : null}
                  </span>
                </Link>
                {link.href === '/' && (
                  <Link
                    href="/logs"
                    onClick={handleNavigate}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2.5 py-1.5 pl-[2.125rem] text-xs transition-colors',
                      isLogsActive
                        ? 'bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)]'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <ScrollText className="h-3.5 w-3.5" />
                    Logs
                  </Link>
                )}
              </div>
            )
          })}

          {pinnedKnives.length > 0 && (
            <>
              <Separator className="my-3" />
              <Collapsible open={pinnedOpen} onOpenChange={setPinnedOpen}>
                <CollapsibleTrigger
                  render={
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--bladevault-title)] transition-colors hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-1"
                    >
                      Pinned
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 transition-transform',
                          pinnedOpen && 'rotate-90',
                        )}
                      />
                    </button>
                  }
                />
                <CollapsibleContent className="space-y-0.5 pl-1 pt-1">
                  {pinnedKnives.map((knife) => {
                    const knifeHref = `/collection/${knife.id}`
                    const isKnifeActive = pathname === knifeHref

                    return (
                      <Link
                        key={knife.id}
                        href={knifeHref}
                        onClick={handleNavigate}
                        className={cn(
                          'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                          isKnifeActive
                            ? 'bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)]'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <Pin className="size-3 shrink-0" />
                        <span className="truncate">
                          <span
                            className={cn(
                              isKnifeActive
                                ? 'text-[var(--bladevault-line)]'
                                : 'text-muted-foreground',
                            )}
                          >
                            {knife.brand}
                          </span>
                          <span
                            className={cn(
                              'mx-1',
                              isKnifeActive
                                ? 'text-[var(--bladevault-line)]'
                                : 'text-muted-foreground/50',
                            )}
                          >
                            ·
                          </span>
                          <span
                            className={cn(
                              'font-medium',
                              isKnifeActive
                                ? 'text-[var(--bladevault-gold)]'
                                : 'text-foreground',
                            )}
                          >
                            {knife.name}
                          </span>
                        </span>
                      </Link>
                    )
                  })}
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          {brands.length > 0 && (
            <>
              <Separator className="my-3" />
              <Collapsible open={brandsOpen} onOpenChange={setBrandsOpen}>
                <CollapsibleTrigger
                  render={
                    <button className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--bladevault-title)] transition-colors hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-1">
                      Brands
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 transition-transform',
                          brandsOpen && 'rotate-90',
                        )}
                      />
                    </button>
                  }
                />
                <CollapsibleContent className="space-y-0.5 pl-1 pt-1">
                  {brands.map((brand) => {
                    const brandHref = `/collection?brand=${encodeURIComponent(brand.name)}`
                    const isBrandActive =
                      pathname === '/collection' &&
                      selectedBrands.length === 1 &&
                      selectedBrands[0] === brand.name

                    return (
                      <Link
                        key={brand.name}
                        href={brandHref}
                        onClick={handleNavigate}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs transition-colors',
                          isBrandActive
                            ? 'bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)]'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <span className="truncate">{brand.name}</span>
                        <span
                          className={cn(
                            'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                            isBrandActive
                              ? 'bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)]'
                              : 'bg-muted text-foreground',
                          )}
                        >
                          {brand.count}
                        </span>
                      </Link>
                    )
                  })}
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </nav>

        <div className="flex flex-col gap-2 border-t bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={toggleTheme}
            >
              <Sun className="h-3.5 w-3.5 dark:hidden" />
              <Moon className="hidden h-3.5 w-3.5 dark:block" />
            </Button>

            <Button
              variant="outline"
              size="sm"
              aria-label="Settings"
              className={cn(
                'flex-1',
                isSettingsActive &&
                  'border-[var(--bladevault-olive)] bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)] hover:bg-[var(--bladevault-olive)] hover:text-[var(--bladevault-gold)]',
              )}
              render={<Link href="/settings" onClick={handleNavigate} />}
              nativeButton={false}
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>

            <Button
              variant="outline"
              size="sm"
              aria-label="Cloud Backup"
              title={
                isAutoBackupActive
                  ? 'Cloud auto backup is active. Open Cloud Backup settings.'
                  : 'Cloud auto backup is inactive. Open Cloud Backup settings.'
              }
              className={cn(
                'flex-1',
                isCloudBackupSettingsActive &&
                  'border-[var(--bladevault-olive)] bg-[var(--bladevault-olive)] text-[var(--bladevault-gold)] hover:bg-[var(--bladevault-olive)] hover:text-[var(--bladevault-gold)]',
              )}
              render={
                <Link
                  href="/settings?tab=cloud-backup"
                  onClick={handleOpenCloudBackup}
                />
              }
              nativeButton={false}
            >
              {isAutoBackupActive ? (
                <Cloud
                  className="h-3.5 w-3.5"
                  style={{ stroke: 'url(#sidebar-cloud-gradient)' }}
                />
              ) : (
                <CloudOff className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
              )}
            </Button>
          </div>
        </div>
      </aside>
    )
  }

  return (
    <>
      <svg width="0" height="0" className="absolute print:hidden">
        <defs>
          <linearGradient
            id="sidebar-cloud-gradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#e2c86e" />
            <stop offset="55%" stopColor="#c89c3d" />
            <stop offset="100%" stopColor="#9e6e1b" />
          </linearGradient>
        </defs>
      </svg>

      <div className="flex items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar px-4 py-3 print:hidden md:hidden">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <div className="relative h-10 w-10 shrink-0">
            <Image
              src="/logo.svg"
              alt="BladeVault logo"
              fill
              sizes="40px"
              unoptimized
              className="object-contain p-1"
              priority
            />
          </div>
          <span className="truncate text-xl font-semibold tracking-tight text-foreground">
            <span>Blade</span>
            <span style={{ color: 'var(--bladevault-title)' }}>Vault</span>
          </span>
        </Link>

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setMobileNavSession(routeKey)}
          aria-label="Open navigation"
          aria-expanded={isMobileNavOpen}
        >
          <Menu className="h-4 w-4" />
        </Button>
      </div>

      {isMobileNavOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/45 print:hidden md:hidden"
          onClick={closeMobileNav}
        >
          <div className="h-full" onClick={(event) => event.stopPropagation()}>
            {renderSidebarContent(true)}
          </div>
        </div>
      )}

      {renderSidebarContent(false)}
    </>
  )
}
