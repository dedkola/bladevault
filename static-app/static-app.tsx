'use client'

import { lazy, Suspense, useEffect, useState } from 'react'
import { AppShell } from '@/components/app-shell'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import {
  KnivesProvider,
  useKnives,
} from '@/components/providers/knives-provider'
import { ComparisonsProvider } from '@/components/providers/comparisons-provider'
import { SmartCollectionsProvider } from '@/components/providers/smart-collections-provider'
import { KnifeFamilyPanelProvider } from '@/components/providers/knife-family-panel-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { VaultRestoreProvider } from '@/components/providers/vault-restore-provider'
import { ThemeColorSync } from '@/components/theme-color-sync'
import { PageHeader } from '@/components/page-header'
import {
  installBrowserNavigation,
  navigate,
  useLocation,
  usePathname,
  useSearchParams,
} from './navigation'
import {
  installBrowserApi,
  readSessionKnife,
  resetSession,
  STATIC_VAULT_STATUS,
} from './browser-api'

const Home = lazy(() => import('@/app/page'))
const Collection = lazy(() => import('@/app/collection/page'))
const Add = lazy(() => import('@/app/add/page'))
const Compare = lazy(() => import('@/app/compare/page'))
const Settings = lazy(() => import('@/app/settings/page'))
const Logs = lazy(() => import('@/app/logs/page'))
const KnifeDetail = lazy(() => import('@/components/knife-detail'))
const InsightPage = lazy(() =>
  import('./insight-page').then((module) => ({ default: module.InsightPage })),
)

function Route() {
  const pathname = usePathname(),
    params = useSearchParams()
  const { knives, isLoading } = useKnives()
  if (pathname === '/') return <Home />
  if (pathname === '/collection') return <Collection />
  if (pathname === '/add') return <Add />
  if (pathname === '/compare') return <Compare />
  if (pathname === '/settings') return <Settings />
  if (pathname === '/logs') return <Logs />
  const detail = pathname.match(/^\/collection\/([^/]+)$/)
  if (detail) {
    if (isLoading)
      return (
        <div role="status" className="p-8 text-sm text-muted-foreground">
          Loading knife…
        </div>
      )
    const knife = knives.find((k) => k.id === decodeURIComponent(detail[1]))
    const fullKnife = knife && readSessionKnife(knife.id)
    if (fullKnife)
      return (
        <KnifeDetail
          key={fullKnife.id}
          knife={fullKnife}
          initialEditing={params.get('edit') === '1'}
        />
      )
  }
  const insight = pathname.match(/^\/insights\/([^/]+)$/)
  if (insight) return <InsightPage slug={insight[1]} />
  return (
    <div className="p-8">
      <PageHeader
        title="Page not found"
        description="Return to your collection to continue."
      />
    </div>
  )
}

export function StaticApp() {
  const location = useLocation()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    const restore = installBrowserApi()
    const restoreNavigation = installBrowserNavigation()
    queueMicrotask(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
      restoreNavigation()
      restore()
    }
  }, [])
  if (!ready || !location)
    return (
      <div role="status" className="p-8 text-sm text-muted-foreground">
        Loading BladeVault…
      </div>
    )
  return (
    <Suspense>
      <VaultRestoreProvider initialStatus={STATIC_VAULT_STATUS}>
        <KnivesProvider>
          <SmartCollectionsProvider>
            <TooltipProvider>
              <ComparisonsProvider>
                <KnifeFamilyPanelProvider>
                  <ThemeColorSync />
                  <div className="flex min-h-dvh flex-col">
                    <div className="sticky top-0 z-40 flex h-8 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 text-xs text-muted-foreground print:hidden">
                      <span>Browser preview · Data stays in this tab</span>
                      <button
                        className="shrink-0 underline underline-offset-2"
                        onClick={() => {
                          if (
                            window.confirm(
                              'Clear this tab’s collection and settings?',
                            )
                          ) {
                            resetSession()
                            navigate('/', true)
                            window.location.reload()
                          }
                        }}
                      >
                        Clear session
                      </button>
                    </div>
                    <div className="static-preview-layout flex flex-1 flex-col md:flex-row">
                      <AppShell>
                        <Suspense
                          fallback={
                            <div
                              role="status"
                              className="p-8 text-sm text-muted-foreground"
                            >
                              Loading BladeVault…
                            </div>
                          }
                        >
                          <Route />
                        </Suspense>
                      </AppShell>
                    </div>
                  </div>
                  <GlobalKnifeSearch />
                </KnifeFamilyPanelProvider>
              </ComparisonsProvider>
            </TooltipProvider>
          </SmartCollectionsProvider>
        </KnivesProvider>
      </VaultRestoreProvider>
    </Suspense>
  )
}
