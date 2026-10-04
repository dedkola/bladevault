'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { readCleanupQueue, type CleanupQueue } from '@/lib/collection-cleanup'

const storageKey = 'bladevault:collection-cleanup:v1'
const eventName = 'bladevault:cleanup-progress'
let fallback: string | null = null
let writeFailed = false

function subscribe(callback: () => void) {
  window.addEventListener(eventName, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(eventName, callback)
    window.removeEventListener('storage', callback)
  }
}
function snapshot() {
  if (writeFailed) return fallback
  try {
    fallback = window.sessionStorage.getItem(storageKey)
    return fallback
  } catch {
    return fallback
  }
}
const serverSnapshot = () => null

export function useCleanupQueue() {
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const queue = useMemo(() => readCleanupQueue(raw), [raw])
  const setQueue = (next: CleanupQueue | null) => {
    fallback = next ? JSON.stringify(next) : null
    try {
      if (fallback) window.sessionStorage.setItem(storageKey, fallback)
      else window.sessionStorage.removeItem(storageKey)
      writeFailed = false
    } catch {
      /* Keep progress in memory when browser storage is unavailable. */
      writeFailed = true
    }
    window.dispatchEvent(new Event(eventName))
  }
  return [queue, setQueue] as const
}
