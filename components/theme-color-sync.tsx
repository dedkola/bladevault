'use client'

import { useEffect } from 'react'

export function ThemeColorSync() {
  useEffect(() => {
    const root = document.documentElement
    const update = () => {
      const isDark = root.classList.contains('dark')
      const isModern = root.dataset.themeStyle === 'modern'
      const themeColor = isModern
        ? isDark
          ? '#0d0d0f'
          : '#f5f5f7'
        : isDark
          ? '#18150f'
          : '#fcfcfb'
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
