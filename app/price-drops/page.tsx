import type { Metadata } from 'next'
import { PriceDropsView } from '@/components/price-drops/price-drops-view'

export const metadata: Metadata = {
  title: 'BladeVault | Price Drops',
  description:
    'Market prices, price changes and stock for knives in your collection.',
}

export default async function PriceDropsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[] }>
}) {
  const { section } = await searchParams
  return (
    <div
      data-price-drops-page
      className="flex w-full flex-1 flex-col p-4 sm:p-6 lg:p-8"
    >
      <PriceDropsView
        initialSection={typeof section === 'string' ? section : undefined}
      />
    </div>
  )
}
