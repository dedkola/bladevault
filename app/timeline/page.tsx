import type { Metadata } from 'next'
import { TimelinePage } from '@/components/timeline-page'

export const metadata: Metadata = {
  title: 'BladeVault | Timeline',
  description: 'The story of your collection over time.',
}

export default function Page() {
  return <TimelinePage />
}
