import { Suspense } from 'react'
import { ComparisonsProvider } from '@/components/providers/comparisons-provider'
import type { Metadata, Viewport } from 'next'
import './globals.css'
import './alloy.css'
import { SmartCollectionsProvider } from '@/components/providers/smart-collections-provider'
import { AppShell } from '@/components/app-shell'
import { KnivesProvider } from '@/components/providers/knives-provider'
import { DEFAULT_SETTINGS, getSettings } from '@/lib/settings'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Geist, Geist_Mono } from 'next/font/google'
import localFont from 'next/font/local'
import { cn } from '@/lib/utils'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { ThemeColorSync } from '@/components/theme-color-sync'
import { cookies } from 'next/headers'
import { isAppLockEnabled, isAppUnlocked } from '@/lib/app-lock'
import { APP_LOCK_COOKIE } from '@/lib/app-lock-shared'
import { AppUnlockForm } from '@/components/app-unlock-form'
import { AppLockSession } from '@/components/app-lock-session'
import { VaultRestoreProvider } from '@/components/providers/vault-restore-provider'
import { getVaultAccessState } from '@/lib/vault-access'
import { getErrorReportingConfig } from '@/lib/sentry/server'
import { ERROR_REPORTING_ATTRIBUTE } from '@/lib/sentry/shared'

const geistSans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })
const alloyDisplay = localFont({
  src: '../public/fonts/barlow-condensed-semibold.ttf',
  variable: '--font-display',
  weight: '600',
  display: 'swap',
  preload: false,
})

export const metadata: Metadata = {
  title: 'BladeVault | Knife Collection',
  description: 'Manage your local knife collection.',
}

export function generateViewport(): Viewport {
  const theme = getInitialTheme()
  const themeStyle = getInitialThemeStyle()

  return {
    themeColor:
      themeStyle === 'alloy'
        ? theme === 'dark'
          ? '#080808'
          : '#101010'
        : themeStyle === 'modern'
          ? theme === 'dark'
            ? '#0d0d0f'
            : '#f5f5f7'
          : theme === 'dark'
            ? '#18150f'
            : '#fcfcfb',
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

function getInitialThemeStyle() {
  try {
    return getSettings().themeStyle
  } catch {
    return DEFAULT_SETTINGS.themeStyle
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const theme = getInitialTheme()
  const themeStyle = getInitialThemeStyle()
  const vaultStatus = {
    ...getVaultAccessState(),
    appLockEnabled: isAppLockEnabled(),
  }
  const unlocked = isAppUnlocked((await cookies()).get(APP_LOCK_COOKIE)?.value)
  const errorReporting = getErrorReportingConfig()

  return (
    <html
      lang="en"
      data-theme-style={themeStyle}
      {...(errorReporting
        ? { [ERROR_REPORTING_ATTRIBUTE]: JSON.stringify(errorReporting) }
        : {})}
      className={cn(
        geistSans.variable,
        geistMono.variable,
        alloyDisplay.variable,
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
            <VaultRestoreProvider initialStatus={vaultStatus}>
              <KnivesProvider initialThemeStyle={themeStyle}>
                <SmartCollectionsProvider>
                  <TooltipProvider>
                    <Suspense>
                      <ComparisonsProvider>
                        <AppShell>{children}</AppShell>
                      </ComparisonsProvider>
                    </Suspense>
                    <GlobalKnifeSearch />
                  </TooltipProvider>
                </SmartCollectionsProvider>
              </KnivesProvider>
            </VaultRestoreProvider>
          </>
        )}
      </body>
    </html>
  )
}
