import { notFound, redirect } from 'next/navigation'
import { getStorage } from '@/lib/storage'
import KnifeDetail from '@/components/knife-detail'
import { requireUnlockedPage } from '@/lib/app-lock-page'

export default async function KnifeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ edit?: string | string[]; tab?: string | string[] }>
}) {
  await requireUnlockedPage()
  const { id } = await params
  const storage = getStorage()
  const knife = await storage.getKnifeById(id)

  if (!knife) return notFound()
  // Wanted knives are not in the collection; the watchlist shows them.
  if (knife.wanted)
    redirect(`/price-drops/watchlist?knife=${encodeURIComponent(knife.id)}`)

  const query = await searchParams

  return (
    <KnifeDetail
      key={knife.id}
      knife={knife}
      initialEditing={query.edit === '1'}
      initialTab={
        query.tab === 'maintenance' || query.tab === 'market'
          ? query.tab
          : 'details'
      }
    />
  )
}
