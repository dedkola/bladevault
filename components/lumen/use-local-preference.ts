'use client'

import { useCallback, useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const memory = new Map<string, string>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * A per-browser display preference (such as tile size or list grouping).
 * Falls back to an in-memory value when storage is unavailable, so the
 * choice still holds for the session.
 */
export function useLocalPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  )
  const value = allowed.includes(stored as T) ? (stored as T) : fallback
  const setValue = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, next)
        memory.delete(key)
      } catch {
        memory.set(key, next)
      }
      listeners.forEach((listener) => listener())
    },
    [key],
  )
  return [value, setValue]
}
