'use client'

import { useEffect } from 'react'
import { THEME_COLORS, readThemeStyleFromElement } from '@/lib/settings-shared'

export function ThemeColorSync() {
  useEffect(() => {
    const root = document.documentElement
    const update = () => {
      const isDark = root.classList.contains('dark')
      const themeStyle = readThemeStyleFromElement(root)
      const themeColor = THEME_COLORS[themeStyle][isDark ? 'dark' : 'light']
      const meta = document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )
      if (meta) meta.content = themeColor
    }

    update()
    const observer = new MutationObserver(update)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-theme-style', 'data-theme-variant'],
    })
    return () => observer.disconnect()
  }, [])

  return null
}
