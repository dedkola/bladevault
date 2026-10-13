'use client'

import { useMemo, useSyncExternalStore } from 'react'

const LOCATION_CHANGED = 'bladevault:static-location'

function subscribe(notify: () => void) {
  window.addEventListener('popstate', notify)
  window.addEventListener(LOCATION_CHANGED, notify)
  return () => {
    window.removeEventListener('popstate', notify)
    window.removeEventListener(LOCATION_CHANGED, notify)
  }
}

export function useLocation() {
  return useSyncExternalStore(
    subscribe,
    () => window.location.href,
    () => '',
  )
}

export function installBrowserNavigation() {
  const { pushState, replaceState } = window.history
  const wrap =
    (method: History['pushState']): History['pushState'] =>
    (...args) => {
      method.apply(window.history, args)
      window.dispatchEvent(new Event(LOCATION_CHANGED))
    }
  const push = wrap(pushState),
    replace = wrap(replaceState)
  window.history.pushState = push
  window.history.replaceState = replace
  return () => {
    if (window.history.pushState === push) window.history.pushState = pushState
    if (window.history.replaceState === replace)
      window.history.replaceState = replaceState
  }
}

export function navigate(href: string, replace = false, scroll = true) {
  const url = new URL(href, window.location.href)
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href)
    return
  }
  window.history[replace ? 'replaceState' : 'pushState'](null, '', url.href)
  if (scroll) window.scrollTo({ top: 0 })
}

const router = {
  push: (href: string, options?: { scroll?: boolean }) =>
    navigate(href, false, options?.scroll !== false),
  replace: (href: string, options?: { scroll?: boolean }) =>
    navigate(href, true, options?.scroll !== false),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => window.location.reload(),
  prefetch: async () => {},
}

export function useRouter() {
  return router
}

export function usePathname() {
  const location = useLocation()
  return location ? new URL(location).pathname.replace(/\/$/, '') || '/' : '/'
}

export function useSearchParams() {
  const location = useLocation()
  return useMemo(
    () => new URLSearchParams(location ? new URL(location).search : ''),
    [location],
  )
}
