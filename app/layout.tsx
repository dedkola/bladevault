import type { Metadata } from 'next'
import './globals.css'
import { SidebarShell } from '@/components/sidebar-shell'
import { KnivesProvider } from '@/components/providers/knives-provider'
import { DEFAULT_SETTINGS, getSettings } from '@/lib/settings'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Geist, Geist_Mono } from 'next/font/google'
import { cn } from '@/lib/utils'
import { GlobalKnifeSearch } from '@/components/global-knife-search'

const geistSans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: 'BladeVault | Knife Collection',
  description: 'Manage your local knife collection.',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
  },
}

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
      <body className="bg-background text-foreground flex h-dvh min-h-0 w-full flex-col overflow-hidden font-sans print:h-auto print:overflow-visible md:flex-row">
        <KnivesProvider>
          <TooltipProvider>
            <SidebarShell />
            <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain print:overflow-visible">
              {children}
            </main>
            <GlobalKnifeSearch />
          </TooltipProvider>
        </KnivesProvider>
      </body>
    </html>
  )
}
