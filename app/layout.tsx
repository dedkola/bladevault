import { Suspense } from 'react'
import { ComparisonsProvider } from '@/components/providers/comparisons-provider'
import type { Metadata, Viewport } from 'next'
import './globals.css'
import './alloy.css'
import './classic.css'
import './modern-variants.css'
import './forge.css'
import './lumen-shells.css'
import './atrium.css'
import './shelf.css'
import { SmartCollectionsProvider } from '@/components/providers/smart-collections-provider'
import { AppShell } from '@/components/app-shell'
import { KnivesProvider } from '@/components/providers/knives-provider'
import { DEFAULT_SETTINGS, getSettings } from '@/lib/settings'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Geist, Geist_Mono, Space_Grotesk } from 'next/font/google'
import localFont from 'next/font/local'
import { cn } from '@/lib/utils'
import { GlobalKnifeSearch } from '@/components/global-knife-search'
import { ThemeColorSync } from '@/components/theme-color-sync'
import { SegmentedHighlight } from '@/components/segmented-highlight'
import {
  THEME_COLORS,
  getModernThemeVariant,
  getThemePalette,
  isDarkThemeActive,
  getThemeFamily,
} from '@/lib/settings-shared'
import { cookies } from 'next/headers'
import { isAppLockEnabled, isAppUnlocked } from '@/lib/app-lock'
import { APP_LOCK_COOKIE } from '@/lib/app-lock-shared'
import { AppUnlockForm } from '@/components/app-unlock-form'
import { AppLockSession } from '@/components/app-lock-session'
import { VaultRestoreProvider } from '@/components/providers/vault-restore-provider'
import { getVaultAccessState } from '@/lib/vault-access'
import {
  getErrorReportingConfig,
  getErrorReportingMode,
  isErrorReportingAllowed,
} from '@/lib/sentry/server'
import { getErrorReportingConsent } from '@/lib/error-reporting-consent'
import { ErrorReportingPrompt } from '@/components/error-reporting-prompt'
import { ERROR_REPORTING_ATTRIBUTE } from '@/lib/sentry/shared'

const geistSans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })
const fieldDisplay = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-field-display',
  weight: ['500', '600', '700'],
  display: 'swap',
  preload: false,
})
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
      THEME_COLORS[themeStyle][
        isDarkThemeActive(theme, themeStyle) ? 'dark' : 'light'
      ],
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

// Reads the vault's answer in consent mode, which also refreshes the copy the
// server's Sentry hooks check. A failed read counts as "not answered".
function getInitialErrorReporting() {
  const mode = getErrorReportingMode()
  let promptForConsent = false
  if (mode === 'consent') {
    try {
      promptForConsent = getErrorReportingConsent() === 'unset'
    } catch {
      promptForConsent = false
    }
  }
  return {
    config: isErrorReportingAllowed() ? getErrorReportingConfig() : null,
    promptForConsent,
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
  const { config: errorReporting, promptForConsent } =
    getInitialErrorReporting()

  return (
    <html
      lang="en"
      data-theme-style={getThemeFamily(themeStyle)}
      data-theme-variant={getModernThemeVariant(themeStyle)}
      data-theme-palette={getThemePalette(themeStyle)}
      data-theme-mode={theme}
      {...(errorReporting
        ? { [ERROR_REPORTING_ATTRIBUTE]: JSON.stringify(errorReporting) }
        : {})}
      className={cn(
        geistSans.variable,
        geistMono.variable,
        alloyDisplay.variable,
        fieldDisplay.variable,
        'h-full',
        isDarkThemeActive(theme, themeStyle) && 'dark',
      )}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground flex min-h-dvh w-full flex-col font-sans md:flex-row">
        <ThemeColorSync />
        <SegmentedHighlight />
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
                    {promptForConsent ? <ErrorReportingPrompt /> : null}
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
