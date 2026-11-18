import type { Metadata } from 'next'
import { PageHeader } from '@/components/page-header'
import { CareInboxView } from '@/components/care-inbox'

export const metadata: Metadata = {
  title: 'BladeVault | Inbox',
  description:
    'Care reminders, price changes and app messages such as failed backups.',
}

export default function InboxPage() {
  return (
    <div
      data-inbox-content
      className="flex w-full flex-1 flex-col p-4 sm:p-6 lg:p-8"
    >
      <PageHeader
        title="Inbox"
        description="Care reminders, price drops and restocks, and important app messages, like a failed backup."
      />
      <CareInboxView />
    </div>
  )
}
