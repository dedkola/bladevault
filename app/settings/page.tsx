import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHeader } from '@/components/page-header'
import SettingsView from '@/components/settings-view'

export const metadata: Metadata = {
  title: 'BladeVault | Settings',
  description: 'Manage your vault preferences and backups.',
}

export default function SettingsPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col p-6 lg:p-8 w-full max-w-7xl mx-auto">
      <PageHeader
        title="Settings"
        description="Manage your vault preferences and backups."
      />
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <SettingsView />
        </Suspense>
      </div>
    </div>
  )
}
