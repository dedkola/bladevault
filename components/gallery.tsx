'use client'

import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'
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
  const fullscreenThumbnailRefs = useRef<(HTMLButtonElement | null)[]>([])

  const nextImage = () => setActiveIdx((prev) => (prev + 1) % images.length)
  const prevImage = () =>
    setActiveIdx((prev) => (prev - 1 + images.length) % images.length)

  useEffect(() => {
    if (images.length <= 1) return

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

  useEffect(() => {
    if (!isFullScreen || images.length <= 1) return

    fullscreenThumbnailRefs.current[activeIdx]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    })
  }, [activeIdx, images.length, isFullScreen])

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
                  alt={
                    images.length > 1
                      ? `Knife image ${activeIdx + 1} of ${images.length}`
                      : 'Knife detailed view'
                  }
                  fill
                  sizes="(max-width: 1024px) 100vw, (max-width: 1536px) 60vw, 70vw"
                  className="object-contain"
                  referrerPolicy="no-referrer"
                  priority
                />
                {images.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={prevImage}
                      className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--bladevault-gold)]/70 bg-[color:var(--bladevault-olive)]/90 text-[var(--bladevault-gold)] shadow-md shadow-black/20 backdrop-blur-sm transition-all hover:scale-105 hover:border-[var(--bladevault-gold)] hover:bg-[var(--bladevault-gold)] hover:text-[var(--bladevault-olive)] active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)]"
                      aria-label="Previous image"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={nextImage}
                      className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--bladevault-gold)]/70 bg-[color:var(--bladevault-olive)]/90 text-[var(--bladevault-gold)] shadow-md shadow-black/20 backdrop-blur-sm transition-all hover:scale-105 hover:border-[var(--bladevault-gold)] hover:bg-[var(--bladevault-gold)] hover:text-[var(--bladevault-olive)] active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)]"
                      aria-label="Next image"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </>
                )}
                {!editable && (
                  <button
                    type="button"
                    onClick={() => setIsFullScreen(true)}
                    className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--bladevault-gold)]/70 bg-[color:var(--bladevault-olive)]/90 text-[var(--bladevault-gold)] opacity-100 transition-colors hover:border-[var(--bladevault-gold)] hover:bg-[var(--bladevault-gold)] hover:text-[var(--bladevault-olive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] lg:opacity-0 lg:group-hover/gallery:opacity-100 lg:focus-visible:opacity-100"
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
                    <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center py-1 bg-gradient-to-b from-black/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <GripHorizontal className="h-4 w-4 text-white" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between px-1 py-1 bg-gradient-to-t from-black/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
          className="inset-0 block h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-none bg-[#0b0b09] p-0 text-white ring-0 sm:max-w-none"
        >
          <header className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-between bg-gradient-to-b from-black/80 via-black/35 to-transparent px-4 pb-10 pt-4 sm:px-6 sm:pt-5">
            <div className="flex min-w-0 items-center gap-3">
              <DialogTitle className="truncate text-sm font-semibold tracking-[-0.01em] text-white sm:text-base">
                Image viewer
              </DialogTitle>
              {images.length > 1 && (
                <span
                  className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[11px] font-medium tabular-nums text-white/75 backdrop-blur-md"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {activeIdx + 1} of {images.length}
                </span>
              )}
            </div>
            <button
              onClick={() => setIsFullScreen(false)}
              className="pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--bladevault-gold)]/70 bg-[color:var(--bladevault-olive)]/90 text-[var(--bladevault-gold)] shadow-lg shadow-black/20 backdrop-blur-md transition-colors hover:border-[var(--bladevault-gold)] hover:bg-[var(--bladevault-gold)] hover:text-[var(--bladevault-olive)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)]"
              aria-label="Close image viewer"
            >
              <X className="h-5 w-5" />
            </button>
          </header>

          {images.length > 1 && (
            <button
              onClick={prevImage}
              className="absolute left-3 top-1/2 z-40 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--bladevault-gold)]/70 bg-[color:var(--bladevault-olive)]/90 text-[var(--bladevault-gold)] shadow-lg shadow-black/20 backdrop-blur-md transition-all hover:scale-105 hover:border-[var(--bladevault-gold)] hover:bg-[var(--bladevault-gold)] hover:text-[var(--bladevault-olive)] active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] sm:left-6 sm:h-12 sm:w-12"
              aria-label="Previous image"
            >
              <ChevronLeft className="h-6 w-6 sm:h-7 sm:w-7" />
            </button>
          )}

          <div className="h-full w-full bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.055),transparent_58%)] px-2 pb-28 pt-16 sm:px-20 sm:pb-36 sm:pt-20">
            <div className="relative h-full w-full">
              {images.length > 0 ? (
                <Image
                  key={`fullscreen-${images[activeIdx]}-${activeIdx}`}
                  src={getImageUrl(images[activeIdx])}
                  alt={`Knife image ${activeIdx + 1} of ${images.length}, fullscreen`}
                  fill
                  loading="eager"
                  sizes="100vw"
                  className="object-contain"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <ImageIcon className="h-16 w-16 text-white/35" />
                </div>
              )}
            </div>
          </div>

          {images.length > 1 && (
            <nav
              className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black via-black/90 to-transparent px-3 pb-3 pt-10 sm:px-6 sm:pb-5 sm:pt-14"
              aria-label="Choose an image"
            >
              <div className="mx-auto max-w-5xl">
                <div className="mb-2 hidden items-center justify-between px-1 text-[11px] font-medium text-white/55 sm:flex">
                  <span>Choose image</span>
                  <span>Use ← → keys to browse</span>
                </div>
                <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto px-[calc(50%-2rem)] py-1 [scrollbar-width:none] sm:gap-2.5 sm:px-[calc(50%-2.5rem)] [&::-webkit-scrollbar]:hidden">
                  {images.map((image, index) => (
                    <button
                      key={`${image}-fullscreen-thumbnail-${index}`}
                      ref={(node) => {
                        fullscreenThumbnailRefs.current[index] = node
                      }}
                      onClick={() => setActiveIdx(index)}
                      className={cn(
                        'relative h-16 w-16 shrink-0 snap-center overflow-hidden rounded-md border bg-[#171713] shadow-md shadow-black/30 transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:h-20 sm:w-20',
                        index === activeIdx
                          ? 'scale-[1.03] border-[var(--bladevault-gold)] opacity-100 ring-1 ring-[var(--bladevault-gold)]'
                          : 'border-white/10 opacity-55 hover:border-white/30 hover:opacity-100',
                      )}
                      aria-label={`Show image ${index + 1} of ${images.length}`}
                      aria-pressed={index === activeIdx}
                    >
                      <Image
                        src={getImageUrl(image)}
                        alt=""
                        fill
                        sizes="(max-width: 640px) 64px, 80px"
                        className="object-cover"
                        referrerPolicy="no-referrer"
                      />
                      <span
                        className={cn(
                          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-left text-[10px] font-semibold tabular-nums text-white/65',
                          index === activeIdx && 'text-white',
                        )}
                        aria-hidden="true"
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </nav>
          )}

          {images.length > 1 && (
            <button
              onClick={nextImage}
              className="absolute right-3 top-1/2 z-40 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--bladevault-gold)]/70 bg-[color:var(--bladevault-olive)]/90 text-[var(--bladevault-gold)] shadow-lg shadow-black/20 backdrop-blur-md transition-all hover:scale-105 hover:border-[var(--bladevault-gold)] hover:bg-[var(--bladevault-gold)] hover:text-[var(--bladevault-olive)] active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bladevault-gold)] sm:right-6 sm:h-12 sm:w-12"
              aria-label="Next image"
            >
              <ChevronRight className="h-6 w-6 sm:h-7 sm:w-7" />
            </button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
