'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { getApiErrorMessage, readJsonResponse } from '@/lib/api-response'
import type { SmartCollection } from '@/lib/smart-collections'

async function request<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/smart-collections', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await readJsonResponse<T>(response)
  if (!response.ok)
    throw new Error(
      getApiErrorMessage(data, 'Could not update smart collections.'),
    )
  return data
}
const Context = createContext<{
  collections: SmartCollection[]
  error: string
  save: (
    input: Omit<SmartCollection, 'id'> & { id?: string },
  ) => Promise<SmartCollection>
  remove: (id: string) => Promise<void>
} | null>(null)

export function SmartCollectionsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [collections, setCollections] = useState<SmartCollection[]>([])
  const [error, setError] = useState('')
  const refresh = useCallback(() => {
    void request<{ collections: SmartCollection[] }>('GET')
      .then((data) => {
        setCollections(data.collections)
        setError('')
      })
      .catch(() => setError('Could not load smart collections.'))
  }, [])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  return (
    <Context.Provider
      value={{
        collections,
        error,
        save: async (input) => {
          const { collection } = await request<{ collection: SmartCollection }>(
            'POST',
            input,
          )
          setCollections((current) => {
            const existingIndex = current.findIndex(
              (item) => item.id === collection.id,
            )

            if (existingIndex === -1) return [...current, collection]

            return current.map((item, index) =>
              index === existingIndex ? collection : item,
            )
          })
          return collection
        },
        remove: async (id) => {
          await request('DELETE', { id })
          setCollections((current) => current.filter((item) => item.id !== id))
        },
      }}
    >
      {children}
    </Context.Provider>
  )
}
export function useSmartCollections() {
  const context = useContext(Context)
  if (!context) throw new Error('SmartCollectionsProvider is required')
  return context
}
