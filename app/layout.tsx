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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const theme = getInitialTheme()

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
        <KnivesProvider>
          <SmartCollectionsProvider>
            <TooltipProvider>
              <SidebarShell />
              <main className="flex min-w-0 flex-1 flex-col">{children}</main>
              <GlobalKnifeSearch />
            </TooltipProvider>
          </SmartCollectionsProvider>
        </KnivesProvider>
      </body>
    </html>
  )
}
