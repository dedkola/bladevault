'use client'

import { useEffect } from 'react'
import { normalizeThemeStyle } from '@/lib/settings-shared'

const themeColors = {
  classic: { light: '#fcfcfb', dark: '#18150f' },
  modern: { light: '#f5f5f7', dark: '#0d0d0f' },
  alloy: { light: '#101010', dark: '#080808' },
} as const

export function ThemeColorSync() {
  useEffect(() => {
    const root = document.documentElement
    const update = () => {
      const isDark = root.classList.contains('dark')
      const themeStyle = normalizeThemeStyle(root.dataset.themeStyle)
      const themeColor = themeColors[themeStyle][isDark ? 'dark' : 'light']
      const meta = document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )
      if (meta) meta.content = themeColor
    }

    update()
    const observer = new MutationObserver(update)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme-style'],
    })
    return () => observer.disconnect()
  }, [])

  return null
}
