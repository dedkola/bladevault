'use client'

import { ImageIcon } from 'lucide-react'
import Image from '@/components/vault-image'
import { getImageUrl, type Knife } from '@/lib/data'

/** A knife photo contained in its parent, or a quiet placeholder. */
export function KnifePhoto({
  knife,
  src,
  sizes,
  priority,
  className,
}: {
  knife: Pick<Knife, 'brand' | 'name' | 'images'>
  src?: string
  sizes: string
  priority?: boolean
  className?: string
}) {
  const path = src ?? knife.images[0]
  return (
    <span data-lumen-photo className={className}>
      {path ? (
        <Image
          src={getImageUrl(path)}
          alt={`${knife.brand} ${knife.name}`.trim()}
          fill
          sizes={sizes}
          className="object-contain"
          priority={priority}
        />
      ) : (
        <ImageIcon aria-hidden="true" data-lumen-photo-empty />
      )}
    </span>
  )
}
