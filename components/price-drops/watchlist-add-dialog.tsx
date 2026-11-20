'use client'

import { useId, useRef, useState, type FormEvent } from 'react'
import { Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getImageUrl } from '@/lib/data'
import { parseStoredPrice } from '@/lib/price-monitor/money'
import type { ScrapedProduct } from '@/lib/scrape'
import { requestScrape } from '@/lib/scrape-request'

type Draft = {
  url: string
  name: string
  brand: string
  targetAmount: string
  currency: string
  product: ScrapedProduct | null
}

const EMPTY: Draft = {
  url: '',
  name: '',
  brand: '',
  targetAmount: '',
  currency: 'USD',
  product: null,
}

/**
 * Adds a wanted knife from a product URL (read with the same scraper as Add
 * knife) or by hand, with an optional target price.
 */
export function WatchlistAddDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (knifeId: string) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrapeRef = useRef<AbortController | null>(null)

  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }))

  const close = (next: boolean) => {
    if (!next) {
      scrapeRef.current?.abort()
      scrapeRef.current = null
      setDraft(EMPTY)
      setError(null)
      setReading(false)
    }
    onOpenChange(next)
  }

  const readPage = async () => {
    const url = draft.url.trim()
    if (!url || reading) return
    const controller = new AbortController()
    scrapeRef.current = controller
    setReading(true)
    setError(null)
    try {
      const data = await requestScrape<{ product: ScrapedProduct }>(
        '/api/scrape',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        },
      )
      if (scrapeRef.current !== controller) return
      const product = data.product
      const price = parseStoredPrice(product.specs?.price)
      setDraft((current) => ({
        ...current,
        name: product.name || current.name,
        brand: product.brand || current.brand,
        currency: price?.currency || current.currency,
        // Suggest the current price as a starting target.
        targetAmount:
          current.targetAmount || (price ? String(price.amount) : ''),
        product,
      }))
    } catch (err) {
      if (scrapeRef.current !== controller) return
      setError(
        `${err instanceof Error ? err.message : 'Could not read the page.'} You can still fill in the name and add it.`,
      )
    } finally {
      if (scrapeRef.current === controller) {
        scrapeRef.current = null
        setReading(false)
      }
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft.name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const product = draft.product
      const amount = draft.targetAmount.trim()
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          brand: draft.brand.trim(),
          sourceUrl: product?.sourceUrl || draft.url.trim(),
          description: product?.description ?? '',
          bladeStyle: product?.bladeStyle ?? '',
          handleMaterial: product?.handleMaterial ?? '',
          specs: product?.specs ?? {},
          imageUrls: product?.images.slice(0, 4) ?? [],
          ...(amount
            ? { target: { amount, currency: draft.currency.trim() } }
            : {}),
        }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        knife?: { id: string }
        error?: string
      }
      if (!response.ok || !data.knife)
        throw new Error(data.error ?? 'Could not add the knife.')
      onAdded(data.knife.id)
      close(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the knife.')
    } finally {
      setSaving(false)
    }
  }

  const image = draft.product?.images[0]

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" data-watchlist-add>
        <form onSubmit={(event) => void save(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a wanted knife</DialogTitle>
            <DialogDescription>
              Paste the store’s product page to read its name, photo and price,
              or fill in the name yourself. It stays out of your collection
              until you buy it.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <label htmlFor={`${id}-url`} className="text-xs font-medium">
              Product URL
            </label>
            <div className="flex gap-2">
              <Input
                id={`${id}-url`}
                type="url"
                inputMode="url"
                placeholder="https://"
                value={draft.url}
                onChange={(event) => set({ url: event.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void readPage()}
                disabled={!draft.url.trim() || reading}
              >
                {reading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Search className="size-3.5" />
                )}
                Read page
              </Button>
            </div>
          </div>

          {image ? (
            // Scraped product photos are remote until the knife is saved.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={getImageUrl(image)}
              alt=""
              className="h-28 w-full rounded-lg bg-[var(--bladevault-surface-soft)] object-contain"
            />
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-brand`} className="text-xs font-medium">
                Brand
              </label>
              <Input
                id={`${id}-brand`}
                value={draft.brand}
                onChange={(event) => set({ brand: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-name`} className="text-xs font-medium">
                Name
              </label>
              <Input
                id={`${id}-name`}
                required
                value={draft.name}
                onChange={(event) => set({ name: event.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={`${id}-target`} className="text-xs font-medium">
              Target price{' '}
              <span className="text-muted-foreground">(optional)</span>
            </label>
            <div className="flex gap-2">
              <Input
                id={`${id}-target`}
                inputMode="decimal"
                placeholder="e.g. 120"
                value={draft.targetAmount}
                onChange={(event) => set({ targetAmount: event.target.value })}
              />
              <Input
                aria-label="Currency"
                className="w-20 uppercase"
                maxLength={3}
                value={draft.currency}
                onChange={(event) =>
                  set({ currency: event.target.value.toUpperCase() })
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Your Inbox tells you when a store’s price reaches it, and when the
              knife is back in stock.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!draft.name.trim() || saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Add to watchlist
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
