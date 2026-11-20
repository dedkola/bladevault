import type { Metadata } from 'next'
import { WatchlistView } from '@/components/price-drops/watchlist-view'

export const metadata: Metadata = {
  title: 'BladeVault | Watchlist',
  description: 'Knives you want, with target prices, monitored by Price Drops.',
}

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ knife?: string | string[] }>
}) {
  const { knife } = await searchParams
  return (
    <div
      data-price-drops-page
      className="flex w-full flex-1 flex-col p-4 sm:p-6 lg:p-8"
    >
      <WatchlistView
        initialKnife={typeof knife === 'string' ? knife : undefined}
      />
    </div>
  )
}
