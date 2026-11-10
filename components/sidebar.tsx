'use client'

import { BrandMark } from '@/components/brand-mark'
import Link from 'next/link'
import { ComparisonNavigation } from '@/components/comparison-navigation'
import { useSmartCollections } from '@/components/providers/smart-collections-provider'
import { matchesCollection } from '@/lib/smart-collections'
import Image from '@/components/vault-image'
import { usePathname, useSearchParams } from 'next/navigation'
import { useMemo, useState } from 'react'
import {
  LayoutDashboard,
  Library,
  GalleryVertical,
  PlusCircle,
  ChevronRight,
  Download,
  Loader2,
  Menu,
  Pin,
  History,
  X,
} from 'lucide-react'
import { CompareIcon } from '@/components/icons/compare-icon'
import { cn } from '@/lib/utils'
import { getImageUrl } from '@/lib/data'
import { getKnifeFamilyKey, groupKnifeFamilies } from '@/lib/knife-families'
import { getPinnedDetailLine } from '@/lib/card-fields'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { THEME_STYLE_NAMES, isModernThemeFamily } from '@/lib/settings-shared'
import { useDesktopUpdates } from '@/hooks/use-desktop-updates'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

const links = [
  { href: '/insights', label: 'Insights', icon: LayoutDashboard },
  { href: '/collection', label: 'Collection', icon: Library },
  { href: '/studio', label: 'Studio', icon: GalleryVertical },
  { href: '/compare', label: 'Compare', icon: CompareIcon },
  { href: '/logs', label: 'Logs', icon: History },
]

export function Sidebar() {
  const { collections: smartCollections, error: smartError } =
    useSmartCollections()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchParamsKey = searchParams.toString()
  const selectedBrands = searchParams.getAll('brand')
  const routeKey = searchParamsKey ? `${pathname}?${searchParamsKey}` : pathname
  const {
    knives,
    pinnedCardFields,
    customFieldDefinitions,
    dimensionUnit,
    themeStyle,
  } = useKnives()
  const { update, downloadUpdate } = useDesktopUpdates()
  const [brandsOpen, setBrandsOpen] = useState(true)
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [smartCollectionsOpen, setSmartCollectionsOpen] = useState(true)
  const [mobileNavSession, setMobileNavSession] = useState<string | null>(null)
  const isMobileNavOpen = mobileNavSession === routeKey
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

  const familiesByKey = useMemo(
    () =>
      new Map(
        groupKnifeFamilies(knives).map((family) => [family.key, family.knives]),
      ),
    [knives],
  )

  const closeMobileNav = () => {
    setMobileNavSession(null)
  }

  const renderSidebarContent = (isMobile: boolean) => {
    const handleNavigate = isMobile ? closeMobileNav : undefined

    return (
      <aside
        data-sidebar
        className={cn(
          'flex min-h-0 flex-col bg-sidebar text-sidebar-foreground print:hidden',
          isMobile
            ? 'h-dvh max-h-dvh w-[min(20rem,calc(100vw-2.5rem))] max-w-full border-r border-sidebar-border shadow-2xl'
            : 'hidden h-dvh w-60 shrink-0 border-r border-sidebar-border md:sticky md:top-0 md:flex',
        )}
      >
        <div
          data-sidebar-brand-row
          className="flex items-center justify-between gap-3 px-4 py-4"
        >
          <Link
            href="/"
            onClick={handleNavigate}
            className="flex min-w-0 items-center gap-2.5"
          >
            <div className="relative h-12 w-12 shrink-0" data-sidebar-logo>
              <Image
                data-logo-light
                src="/logo.svg"
                alt="BladeVault logo"
                fill
                sizes="48px"
                unoptimized
                className="object-contain p-1"
                priority
              />
              <Image
                data-logo-dark
                src="/logo-dark.svg"
                alt=""
                fill
                sizes="48px"
                unoptimized
                className="object-contain p-1"
              />
              <BrandMark />
            </div>
            <span className="flex min-w-0 flex-col">
              <span
                className="truncate text-2xl font-semibold tracking-tight text-foreground"
                data-sidebar-brand
              >
                <span>Blade</span>
                <span style={{ color: 'var(--bladevault-title)' }}>Vault</span>
              </span>
              <span
                className="truncate text-[10px] leading-tight font-medium tracking-[0.12em] text-muted-foreground uppercase"
                data-sidebar-theme-name
              >
                {THEME_STYLE_NAMES[themeStyle]}
              </span>
            </span>
          </Link>

          {isMobile && (
            <DialogClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-10"
                  aria-label="Close navigation"
                />
              }
            >
              <X className="h-4 w-4" />
            </DialogClose>
          )}
        </div>

        {!isModernThemeFamily(themeStyle) && (
          <div className="px-4 pb-2">
            <Button
              data-sidebar-add
              size="sm"
              className="w-full"
              render={<Link href="/add" onClick={handleNavigate} />}
              nativeButton={false}
            >
              <PlusCircle className="h-3.5 w-3.5" />
              Add knife
            </Button>
          </div>
        )}

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

        <nav
          data-sidebar-nav
          className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2"
        >
          <div
            data-sidebar-label
            className="px-2 pb-1.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--bladevault-title)]"
          >
            Main
          </div>
          {links.map((link) => {
            if (link.href === '/compare')
              return (
                <ComparisonNavigation
                  key={link.href}
                  onNavigate={handleNavigate}
                />
              )
            const Icon = link.icon
            const isActive =
              pathname === link.href || pathname.startsWith(`${link.href}/`)

            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={handleNavigate}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-[var(--bladevault-nav-active-bg)] text-[var(--bladevault-nav-active-fg)]'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex flex-1 items-center justify-between gap-2">
                  <span>{link.label}</span>
                  {link.href === '/collection' && knives.length > 0 ? (
                    <span
                      data-sidebar-collection-count
                      data-sidebar-count
                      className={cn(
                        'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                        isActive
                          ? 'bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)]'
                          : 'bg-muted text-foreground',
                      )}
                    >
                      {knives.length}
                    </span>
                  ) : null}
                </span>
              </Link>
            )
          })}

          {(smartCollections.length > 0 || smartError) && (
            <>
              <Separator className="my-3" />
              <Collapsible
                open={smartCollectionsOpen}
                onOpenChange={setSmartCollectionsOpen}
              >
                <CollapsibleTrigger
                  render={
                    <button
                      type="button"
                      data-sidebar-label
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--bladevault-title)] transition-colors hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-1"
                    >
                      Smart collections
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 transition-transform',
                          smartCollectionsOpen && 'rotate-90',
                        )}
                      />
                    </button>
                  }
                />
                <CollapsibleContent className="space-y-0.5 pl-1 pt-1">
                  {smartError && (
                    <p role="alert" className="px-2 text-xs text-destructive">
                      {smartError}
                    </p>
                  )}
                  {smartCollections.map((collection) => {
                    const active =
                      pathname === '/collection' &&
                      searchParams.get('smart') === collection.id
                    const rules = new URLSearchParams(collection.query)
                    const count = knives.filter((knife) =>
                      matchesCollection(knife, rules),
                    ).length
                    return (
                      <Link
                        key={collection.id}
                        href={`/collection?${collection.query}&smart=${collection.id}`}
                        onClick={handleNavigate}
                        aria-current={active ? 'page' : undefined}
                        title={collection.name}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                          active
                            ? 'bg-[var(--bladevault-nav-active-bg)] text-[var(--bladevault-nav-active-fg)]'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <span className="min-w-0 truncate">
                          {collection.name}
                        </span>
                        <span
                          data-sidebar-count
                          className={cn(
                            'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                            active
                              ? 'bg-[var(--bladevault-gold)] text-[var(--bladevault-olive)]'
                              : 'bg-muted text-foreground',
                          )}
                        >
                          {count}
                        </span>
                      </Link>
                    )
                  })}
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          {pinnedKnives.length > 0 && (
            <>
              <Separator className="my-3" />
              <Collapsible open={pinnedOpen} onOpenChange={setPinnedOpen}>
                <CollapsibleTrigger
                  render={
                    <button
                      type="button"
                      data-sidebar-label
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
                    const siblings =
                      familiesByKey.get(getKnifeFamilyKey(knife)) ?? []
                    const detailLine = getPinnedDetailLine(
                      knife,
                      pinnedCardFields,
                      customFieldDefinitions,
                      siblings,
                      dimensionUnit,
                    )

                    return (
                      <Link
                        key={knife.id}
                        data-sidebar-pinned-item
                        href={knifeHref}
                        onClick={handleNavigate}
                        title={detailLine || undefined}
                        aria-current={isKnifeActive ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                          isKnifeActive
                            ? 'bg-[var(--bladevault-nav-active-bg)] text-[var(--bladevault-nav-active-fg)]'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {knife.images[0] && (
                          <span data-sidebar-pinned-thumb aria-hidden="true">
                            <Image
                              src={getImageUrl(knife.images[0])}
                              alt=""
                              fill
                              sizes="80px"
                              className="object-contain"
                            />
                          </span>
                        )}
                        <Pin className="size-3 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
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
                          {detailLine && (
                            <span
                              data-sidebar-pinned-details
                              className="mt-0.5 line-clamp-2 text-[10px] leading-4 opacity-80 [overflow-wrap:anywhere]"
                            >
                              {detailLine}
                            </span>
                          )}
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
                    <button
                      data-sidebar-label
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--bladevault-title)] transition-colors hover:text-[var(--bladevault-local)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-1"
                    >
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
                        aria-current={isBrandActive ? 'page' : undefined}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs transition-colors',
                          isBrandActive
                            ? 'bg-[var(--bladevault-nav-active-bg)] text-[var(--bladevault-nav-active-fg)]'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <span className="truncate">{brand.name}</span>
                        <span
                          data-sidebar-count
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
      </aside>
    )
  }

  return (
    <Dialog
      open={isMobileNavOpen}
      onOpenChange={(open) => setMobileNavSession(open ? routeKey : null)}
      triggerId={isMobileNavOpen ? 'mobile-navigation-trigger' : null}
    >
      <div
        data-mobile-navigation-bar
        className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar px-4 py-3 print:hidden md:hidden"
      >
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <div className="relative h-10 w-10 shrink-0">
            <Image
              data-logo-light
              src="/logo.svg"
              alt="BladeVault logo"
              fill
              sizes="80px"
              unoptimized
              className="object-contain p-1"
              priority
            />
            <Image
              data-logo-dark
              src="/logo-dark.svg"
              alt=""
              fill
              sizes="80px"
              unoptimized
              className="object-contain p-1"
            />
            <BrandMark />
          </div>
          <span className="truncate text-xl font-semibold tracking-tight text-foreground">
            <span>Blade</span>
            <span style={{ color: 'var(--bladevault-title)' }}>Vault</span>
          </span>
        </Link>

        <DialogTrigger
          id="mobile-navigation-trigger"
          render={
            <Button
              variant="outline"
              size="icon-sm"
              className="size-10"
              aria-label="Open navigation"
            />
          }
        >
          <Menu className="h-4 w-4" />
        </DialogTrigger>
      </div>

      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/45 backdrop-blur-none print:hidden md:hidden"
        className="top-0 left-0 h-dvh max-h-dvh w-auto max-w-none translate-x-0 translate-y-0 gap-0 rounded-none bg-transparent p-0 ring-0 shadow-none print:hidden md:hidden data-open:slide-in-from-left-4 data-closed:slide-out-to-left-4"
      >
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <DialogDescription className="sr-only">
          Navigate BladeVault and access collection shortcuts.
        </DialogDescription>
        {renderSidebarContent(true)}
      </DialogContent>

      {renderSidebarContent(false)}
    </Dialog>
  )
}
