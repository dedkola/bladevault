import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import localFont from 'next/font/local'
import '@/app/globals.css'
import '@/app/alloy.css'
import '@/app/classic.css'
import './styles.css'

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })
const display = localFont({
  src: '../../public/fonts/barlow-condensed-semibold.ttf',
  variable: '--font-display',
  weight: '600',
  display: 'swap',
  preload: false,
})

export const metadata: Metadata = {
  title: 'BladeVault | Knife Collection',
  description: 'BladeVault browser preview.',
  robots: { index: false, follow: false },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${display.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-dvh font-sans">
        {children}
      </body>
    </html>
  )
}
