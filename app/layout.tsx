import { Suspense } from 'react'
import { ComparisonsProvider } from '@/components/providers/comparisons-provider'
import type { Metadata, Viewport } from 'next'
import './globals.css'
import { SmartCollectionsProvider } from '@/components/providers/smart-collections-provider'
import { SidebarShell } from '@/components/sidebar-shell'
import { KnivesProvider } from '@/components/providers/knives-provider'
import { DEFAULT_SETTINGS, getSettings } from '@/lib/settings'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Geist, Geist_Mono } from 'next/font/google'
import { cn } from '@/lib/utils'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { ThemeColorSync } from '@/components/theme-color-sync'
import { cookies } from 'next/headers'
import { isAppUnlocked } from '@/lib/app-lock'
import { APP_LOCK_COOKIE } from '@/lib/app-lock-shared'
import { AppUnlockForm } from '@/components/app-unlock-form'
import { AppLockSession } from '@/components/app-lock-session'

const geistSans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: 'BladeVault | Knife Collection',
  description: 'Manage your local knife collection.',
}

export function generateViewport(): Viewport {
  return {
    themeColor: getInitialTheme() === 'dark' ? '#18150f' : '#fcfcfb',
  }
}

export const dynamic = 'force-dynamic'

function getInitialTheme() {
  try {
    return getSettings().theme
  } catch {
    return DEFAULT_SETTINGS.theme
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const theme = getInitialTheme()
  const unlocked = isAppUnlocked((await cookies()).get(APP_LOCK_COOKIE)?.value)

  return (
    <html
      lang="en"
      className={cn(
        geistSans.variable,
        geistMono.variable,
        'h-full',
        theme === 'dark' && 'dark',
      )}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground flex min-h-dvh w-full flex-col font-sans md:flex-row">
        <ThemeColorSync />
        {!unlocked ? (
          <AppUnlockForm />
        ) : (
          <>
            <AppLockSession />
            <KnivesProvider>
              <SmartCollectionsProvider>
                <TooltipProvider>
                  <Suspense>
                    <ComparisonsProvider>
                      <SidebarShell />
                      <main
                        tabIndex={-1}
                        className="flex min-w-0 flex-1 flex-col"
                      >
                        {children}
                      </main>
                    </ComparisonsProvider>
                  </Suspense>
                  <GlobalKnifeSearch />
                </TooltipProvider>
              </SmartCollectionsProvider>
            </KnivesProvider>
          </>
        )}
      </body>
    </html>
  )
}
