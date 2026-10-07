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
    <div className="flex h-full min-h-0 w-full flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Settings"
        description="Vault, backups, appearance and integrations for this device."
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <SettingsView />
        </Suspense>
      </div>
    </div>
  )
}
