import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import '@/app/globals.css'
import './styles.css'

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: 'BladeVault | Knife Collection',
  description: 'BladeVault browser preview.',
  robots: { index: false, follow: false },
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-dvh font-sans">
        {children}
      </body>
    </html>
  )
}
