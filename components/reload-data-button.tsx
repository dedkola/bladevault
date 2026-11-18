'use client'

import { useState } from 'react'
import { RotateCw } from 'lucide-react'

/**
 * Hard-reloads the window, like a browser's cache-clearing refresh: drops
 * cached responses and loads every page and collection record fresh from the
 * vault. Cookies and saved preferences stay, so App Lock and settings survive.
 */
export function ReloadDataButton() {
  const [isReloading, setIsReloading] = useState(false)

  const reload = async () => {
    if (isReloading) return
    setIsReloading(true)
    try {
      if ('caches' in window) {
        const keys = await window.caches.keys()
        await Promise.all(keys.map((key) => window.caches.delete(key)))
      }
      const reloadWindow = window.bladevaultDesktop?.reloadWindow
      if (reloadWindow) {
        await reloadWindow()
        return
      }
    } catch {
      // Fall back to a plain reload if a cache could not be cleared.
    }
    window.location.reload()
  }

  return (
    <button
      type="button"
      data-reload-data
      onClick={() => void reload()}
      disabled={isReloading}
      aria-label="Reload data"
      title="Reload data · clear cached data and reload the collection"
    >
      <RotateCw
        className={isReloading ? 'motion-safe:animate-spin' : undefined}
      />
    </button>
  )
}
