import type { Metadata } from 'next'
import { LogSessionsView } from '@/components/log-sessions-view'

export const metadata: Metadata = {
  title: 'BladeVault | Logs',
  description: 'Changes recorded in your vault.',
}

export default function LogsPage() {
  return (
    <div
      data-logs-content
      className="flex h-full min-h-0 w-full flex-1 flex-col p-4 sm:p-6 lg:p-8"
    >
      <div className="min-h-0 flex-1">
        <LogSessionsView />
      </div>
    </div>
  )
}
