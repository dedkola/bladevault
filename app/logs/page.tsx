import type { Metadata } from 'next'
import { LogSessionsView } from '@/components/log-sessions-view'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = {
  title: 'BladeVault | Logs',
  description: 'Changes recorded in your vault.',
}

export default function LogsPage() {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-1 flex-col p-6 lg:p-8">
      <PageHeader title="Logs" />
      <div className="min-h-0 flex-1">
        <LogSessionsView />
      </div>
    </div>
  )
}
