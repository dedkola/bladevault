import { KnifeFamilyPanelProvider } from '@/components/providers/knife-family-panel-provider'

export default function CollectionLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <KnifeFamilyPanelProvider>{children}</KnifeFamilyPanelProvider>
}
