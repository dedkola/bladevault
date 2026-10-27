import type { Metadata } from 'next'
import { StudioView } from '@/components/studio'

export const metadata: Metadata = {
  title: 'Studio | BladeVault',
  description: 'A visual showcase of your knife collection.',
}

export default function StudioPage() {
  return <StudioView />
}
