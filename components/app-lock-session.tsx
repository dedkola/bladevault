'use client'

import { useEffect } from 'react'
import { APP_LOCK_HEADER, type AppLockStatus } from '@/lib/app-lock-shared'

export function AppLockSession() {
  useEffect(() => {
    let active = true
    let redirecting = false
    const originalFetch = window.fetch
    const goToUnlock = () => {
      if (!active || redirecting) return
      redirecting = true
      const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
      window.location.replace(`/unlock?next=${encodeURIComponent(next)}`)
    }
    const guardedFetch: typeof window.fetch = async (...args) => {
      const response = await originalFetch(...args)
      if (response.headers.get(APP_LOCK_HEADER) === '1') void check()
      return response
    }
    window.fetch = guardedFetch
    const check = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const response = await originalFetch('/api/app-lock', {
          cache: 'no-store',
        })
        if (!response.ok) return
        const status: AppLockStatus = await response.json()
        if (!status.unlocked) {
          // An earlier request may have started before a password change or
          // initial enable issued the current cookie. Check that cookie before
          // replacing a session that has just been unlocked.
          const latest = await originalFetch('/api/app-lock', {
            cache: 'no-store',
          })
          if (latest.ok && !((await latest.json()) as AppLockStatus).unlocked)
            goToUnlock()
        }
      } catch {
        // A temporary connection failure does not change the lock state.
      }
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    void check()
    return () => {
      active = false
      if (window.fetch === guardedFetch) window.fetch = originalFetch
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  return null
}
