import { notFound } from 'next/navigation'
import { getStorage } from '@/lib/storage'
import KnifeDetail from '@/components/knife-detail'

export default async function KnifeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const storage = getStorage()
  const knife = await storage.getKnifeById(id)

  if (!knife) return notFound()

  return <KnifeDetail key={knife.id} knife={knife} />
}
