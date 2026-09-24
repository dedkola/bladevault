'use client'

import { useEffect } from 'react'

export function ThemeColorSync() {
  useEffect(() => {
    const root = document.documentElement
    const update = () => {
      const themeColor = root.classList.contains('dark') ? '#18150f' : '#fcfcfb'
      const meta = document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )
      if (meta) meta.content = themeColor
    }

    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return null
}
