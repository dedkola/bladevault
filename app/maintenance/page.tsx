import type { Metadata } from 'next'
import { CareDetail } from '@/components/insight-pages/care-detail'
import { InsightDetailShell } from '@/components/insight-pages/insight-detail-shell'

export const metadata: Metadata = {
  title: 'BladeVault | Maintenance',
  description: 'Care status and maintenance history for your collection.',
}

export default function MaintenancePage() {
  return (
    <InsightDetailShell
      eyebrow="Maintenance"
      title="Care status"
      description="Knives due for sharpening, cleaning or lubrication, based on your maintenance log."
      backHref="/collection"
      backLabel="Back to collection"
    >
      <CareDetail />
    </InsightDetailShell>
  )
}
