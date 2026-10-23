import type { CSSProperties } from 'react'

export const activeKnifeActionStyle = {
  backgroundColor:
    'var(--bladevault-action-active-bg, var(--bladevault-olive))',
} satisfies CSSProperties

export const activeKnifeOutlineClassName =
  'border-[var(--bladevault-line)] text-[var(--bladevault-gold)] hover:text-[var(--bladevault-gold)]'

export const activeKnifeFloatingClassName =
  'border-[var(--bladevault-line)] text-[var(--bladevault-gold)] hover:bg-[var(--bladevault-action-active-bg,var(--bladevault-olive))] hover:text-[var(--bladevault-gold)]'
