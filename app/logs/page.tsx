import type { Metadata } from 'next'
import { LogSessionsView } from '@/components/log-sessions-view'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = {
  title: 'BladeVault | Logs',
  description: 'Audit trail of changes in your vault.',
}

export default function LogsPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col p-6 lg:p-8 w-full max-w-7xl mx-auto">
      <PageHeader
        title="Log sessions"
        description="A clear history of what changed in your vault, whether it came from you, an AI client, or an automated process."
        breadcrumbs={[{ label: 'Insights', href: '/' }, { label: 'Logs' }]}
        actions={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-emerald-500" />
            Recording locally
          </div>
        }
      />
      <div className="min-h-0 flex-1">
        <LogSessionsView />
      </div>
    </div>
  )
}
