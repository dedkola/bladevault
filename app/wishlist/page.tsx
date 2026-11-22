import type { Metadata } from 'next'
import { WishlistView } from '@/components/wishlist/wishlist-view'

export const metadata: Metadata = {
  title: 'BladeVault | Wishlist',
  description: 'Knives you plan to buy, by priority and price.',
}

export default function WishlistPage() {
  return (
    <div
      data-wishlist-page
      className="flex w-full flex-1 flex-col p-4 sm:p-6 lg:p-8"
    >
      <WishlistView />
    </div>
  )
}
