import { notFound } from 'next/navigation'
import { getStorage } from '@/lib/storage'
import KnifeDetail from '@/components/knife-detail'
import { requireUnlockedPage } from '@/lib/app-lock-page'

export default async function KnifeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ edit?: string | string[] }>
}) {
  await requireUnlockedPage()
  const { id } = await params
  const storage = getStorage()
  const knife = await storage.getKnifeById(id)

  if (!knife) return notFound()

  const query = await searchParams

  return (
    <KnifeDetail
      key={knife.id}
      knife={knife}
      initialEditing={query.edit === '1'}
    />
  )
}
