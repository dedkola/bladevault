'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { getImageUrl } from '@/lib/data'
import {
  Maximize2,
  X,
  ChevronLeft,
  ChevronRight,
  GripHorizontal,
  ImageIcon,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

export function Gallery({
  images,
  editable = false,
  onReorder,
}: {
  images: string[]
  editable?: boolean
  onReorder?: (newImages: string[]) => void
}) {
  const [activeIdx, setActiveIdx] = useState(0)
  const [isFullScreen, setIsFullScreen] = useState(false)

  const nextImage = () => setActiveIdx((prev) => (prev + 1) % images.length)
  const prevImage = () =>
    setActiveIdx((prev) => (prev - 1 + images.length) % images.length)

  useEffect(() => {
    if (!isFullScreen || images.length <= 1) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setActiveIdx((prev) => (prev - 1 + images.length) % images.length)
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setActiveIdx((prev) => (prev + 1) % images.length)
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [images.length, isFullScreen])

  const moveImage = (index: number, direction: -1 | 1) => {
    if (!onReorder) return
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= images.length) return

    const reordered = [...images]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(newIndex, 0, moved)

    if (activeIdx === index) {
      setActiveIdx(newIndex)
    } else if (direction === 1 && activeIdx > index && activeIdx <= newIndex) {
      setActiveIdx(activeIdx - 1)
    } else if (direction === -1 && activeIdx < index && activeIdx >= newIndex) {
      setActiveIdx(activeIdx + 1)
    }

    onReorder(reordered)
  }

  return (
    <>
      <div className="space-y-4">
        <Card className="group/gallery overflow-hidden p-0">
          <div className="relative aspect-video lg:aspect-[4/3] w-full bg-white">
            {images.length > 0 ? (
              <>
                <Image
                  src={getImageUrl(images[activeIdx])}
                  alt="Knife detailed view"
                  fill
                  sizes="(max-width: 1024px) 100vw, (max-width: 1536px) 60vw, 70vw"
                  className="object-contain"
                  referrerPolicy="no-referrer"
                  priority
                />
                {!editable && (
                  <button
                    onClick={() => setIsFullScreen(true)}
                    className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white opacity-100 transition-opacity hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 lg:opacity-0 lg:group-hover/gallery:opacity-100 lg:focus-visible:opacity-100"
                    aria-label="View fullscreen"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </>
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-muted/50">
                <ImageIcon className="h-12 w-12 text-muted-foreground/50" />
              </div>
            )}
          </div>
        </Card>

        {images.length > 1 && (
          <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible lg:pb-0">
            {images.map((img, idx) => (
              <Card
                key={idx}
                className={cn(
                  'group relative h-20 w-20 shrink-0 snap-start overflow-hidden p-0 bg-white transition-all',
                  activeIdx === idx
                    ? 'ring-2 ring-[var(--bladevault-title)] ring-offset-1'
                    : 'opacity-70 hover:opacity-100',
                )}
              >
                <button
                  onClick={() => setActiveIdx(idx)}
                  className="absolute inset-0 z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-inset"
                  aria-label={`Select thumbnail ${idx + 1}`}
                />
                <Image
                  src={getImageUrl(img)}
                  alt={`Thumbnail ${idx}`}
                  fill
                  sizes="80px"
                  className="object-cover"
                  referrerPolicy="no-referrer"
                />
                {editable && (
                  <>
                    <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center py-1 bg-gradient-to-b from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                      <GripHorizontal className="h-4 w-4 text-white" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between px-1 py-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          moveImage(idx, -1)
                        }}
                        disabled={idx === 0}
                        className="rounded-full bg-white/90 p-1 text-foreground transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] disabled:opacity-30 disabled:hover:bg-white/90"
                        aria-label="Move image left"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          moveImage(idx, 1)
                        }}
                        disabled={idx === images.length - 1}
                        className="rounded-full bg-white/90 p-1 text-foreground transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] disabled:opacity-30 disabled:hover:bg-white/90"
                        aria-label="Move image right"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={isFullScreen} onOpenChange={setIsFullScreen}>
        <DialogContent
          showCloseButton={false}
          className="max-w-[calc(100%-2rem)] h-[90vh] w-[90vw] border-none bg-black/95 p-0 text-white sm:max-w-[90vw] rounded-none"
        >
          <DialogTitle className="sr-only">Image viewer</DialogTitle>
          <button
            onClick={() => setIsFullScreen(false)}
            className="absolute right-4 top-4 z-50 flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>

          {images.length > 1 && (
            <div
              className="absolute left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs font-medium tabular-nums text-white"
              aria-live="polite"
            >
              {activeIdx + 1} / {images.length}
            </div>
          )}

          {images.length > 1 && (
            <button
              onClick={prevImage}
              className="absolute left-4 top-1/2 z-50 -translate-y-1/2 rounded-full p-3 text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              aria-label="Previous image"
            >
              <ChevronLeft className="h-8 w-8" />
            </button>
          )}

          <div className="relative h-full w-full bg-black">
            {images.length > 0 ? (
              images.map((image, index) => (
                <Image
                  key={`${image}-${index}`}
                  src={getImageUrl(image)}
                  alt={index === activeIdx ? 'Knife full screen' : ''}
                  aria-hidden={index !== activeIdx}
                  fill
                  loading="eager"
                  sizes="90vw"
                  className={cn(
                    'object-contain',
                    index === activeIdx ? 'z-10 opacity-100' : 'z-0 opacity-0',
                  )}
                  referrerPolicy="no-referrer"
                />
              ))
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <ImageIcon className="h-16 w-16 text-white/50" />
              </div>
            )}
          </div>

          {images.length > 1 && (
            <button
              onClick={nextImage}
              className="absolute right-4 top-1/2 z-50 -translate-y-1/2 rounded-full p-3 text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              aria-label="Next image"
            >
              <ChevronRight className="h-8 w-8" />
            </button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
