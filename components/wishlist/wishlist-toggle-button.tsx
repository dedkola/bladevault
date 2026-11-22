'use client'

import { useCallback, useState } from 'react'
import { Heart, Loader2 } from 'lucide-react'
import { useKnives } from '@/components/providers/knives-provider'
import { useWishlist } from '@/components/providers/wishlist-provider'
import { Button } from '@/components/ui/button'
import {
  activeKnifeActionStyle,
  activeKnifeOutlineClassName,
} from '@/lib/knife-action-styles'
import { cn } from '@/lib/utils'

/** Adds a knife to the wishlist or takes it off, with toast feedback. */
export function useWishlistToggle(knifeId: string, knifeName: string) {
  const { available, has, mutate, loading, error } = useWishlist()
  const { showFeedback } = useKnives()
  const [saving, setSaving] = useState(false)
  const listed = has(knifeId)

  const toggle = useCallback(async () => {
    setSaving(true)
    try {
      await mutate(
        listed
          ? { action: 'remove', knifeIds: [knifeId] }
          : { action: 'add', knifeIds: [knifeId], lane: 'saving' },
        listed
          ? `Removed ${knifeName} from the wishlist`
          : `Added ${knifeName} to the wishlist`,
      )
    } catch (err) {
      showFeedback(
        err instanceof Error ? err.message : 'Could not update the wishlist.',
        'error',
      )
    } finally {
      setSaving(false)
    }
  }, [listed, mutate, knifeId, knifeName, showFeedback])

  return {
    available,
    listed,
    saving,
    disabled: saving || loading || Boolean(error),
    toggle,
  }
}

/** Knife page action: adds the knife to the wishlist or takes it off. */
export function WishlistToggleButton({
  knifeId,
  knifeName,
  disabled,
}: {
  knifeId: string
  knifeName: string
  disabled?: boolean
}) {
  const wishlist = useWishlistToggle(knifeId, knifeName)
  if (!wishlist.available) return null
  const { listed, saving } = wishlist

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void wishlist.toggle()}
      aria-pressed={listed}
      disabled={disabled || wishlist.disabled}
      className={cn(
        'text-[var(--bladevault-olive)] hover:text-[var(--bladevault-olive)] dark:text-[var(--bladevault-gold)] dark:hover:text-[var(--bladevault-gold)]',
        listed && activeKnifeOutlineClassName,
      )}
      style={listed ? activeKnifeActionStyle : undefined}
    >
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Heart className={cn('h-3.5 w-3.5', listed && 'fill-current')} />
      )}
      {listed ? 'On wishlist' : 'Wishlist'}
    </Button>
  )
}
