'use client'

import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * V-Edge mark used by the Forge, Titanium and Field themes: a "V" whose right
 * stroke is a blade. The left stroke follows `currentColor`; the blade reads
 * its gradient from the `--brand-blade-*` theme tokens.
 */
export function BrandMark({ className }: { className?: string }) {
  const gradientId = `brand-blade-${useId().replace(/:/g, '')}`

  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      data-brand-mark
      className={cn('block', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--brand-blade-from)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--brand-blade-mid)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-blade-to)' }} />
        </linearGradient>
      </defs>
      <path d="M5 8H15L25 36L21 44Z" fill="currentColor" />
      <path d="M43 6L32 6L21 37L25 44Z" fill={`url(#${gradientId})`} />
      <path
        d="M37.5 6L24 41"
        stroke="rgb(255 255 255 / 50%)"
        strokeWidth="1.2"
      />
    </svg>
  )
}
