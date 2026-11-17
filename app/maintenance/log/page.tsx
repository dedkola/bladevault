import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { LogSessionsView } from '@/components/log-sessions-view'

export const metadata: Metadata = {
  title: 'BladeVault | Care log',
  description: 'Every maintenance entry recorded in your vault.',
}

export default function CareLogPage() {
  return (
    <div
      data-logs-content
      className="flex h-full min-h-0 w-full flex-1 flex-col p-4 sm:p-6 lg:p-8"
    >
      <Link
        href="/maintenance"
        className="mb-3 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" aria-hidden="true" />
        Back to maintenance
      </Link>
      <div className="min-h-0 flex-1">
        <LogSessionsView scope="maintenance" />
      </div>
    </div>
  )
}
