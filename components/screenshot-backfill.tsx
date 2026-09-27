'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from '@/components/settings-panels'
import { useKnives } from '@/components/providers/knives-provider'
import { readJsonResponse } from '@/lib/api-response'
import type { ScreenshotBackfillItem } from '@/lib/webpage-screenshot-shared'

type Response = { items?: ScreenshotBackfillItem[]; error?: string }

export function ScreenshotBackfill() {
  const [items, setItems] = useState<ScreenshotBackfillItem[]>([])
  const [running, setRunning] = useState(false)
  const [current, setCurrent] = useState('')
  const [error, setError] = useState('')
  const stop = useRef(false)
  const active = useRef(false)
  const { refreshVault, scheduleVaultBackup } = useKnives()
  const load = useCallback(async () => {
    const response = await fetch('/api/settings/webpage-screenshots')
    const data = await readJsonResponse<Response>(response)
    if (!response.ok)
      throw new Error(data.error || 'Unable to load screenshot backlog')
    setItems(data.items || [])
  }, [])

  useEffect(() => {
    stop.current = false
    void Promise.resolve()
      .then(load)
      .catch((error) => setError(String(error)))
    return () => {
      stop.current = true
    }
  }, [load])

  // Another tab or an interrupted request may still own a short capture lease.
  useEffect(() => {
    if (running || !items.some((item) => item.status === 'running')) return
    const timer = setInterval(() => {
      void load().catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [items, load, running])

  async function run() {
    if (active.current) return
    active.current = true
    stop.current = false
    setRunning(true)
    setError('')
    const pending = items.filter(
      (item) => item.status === 'pending' || item.status === 'failed',
    )
    try {
      for (const item of pending) {
        if (stop.current) break
        setCurrent(item.name)
        const response = await fetch('/api/settings/webpage-screenshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        })
        const data = await readJsonResponse<Response>(response)
        if (data.items) setItems(data.items)
        if (!response.ok && !data.items)
          throw new Error(data.error || 'Capture failed')
      }
      await refreshVault()
      scheduleVaultBackup()
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Capture interrupted. You can resume this run.',
      )
    } finally {
      active.current = false
      setRunning(false)
      setCurrent('')
    }
  }

  async function skip(id: string) {
    try {
      const response = await fetch('/api/settings/webpage-screenshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'skip' }),
      })
      const data = await readJsonResponse<Response>(response)
      if (!response.ok) throw new Error(data.error || 'Unable to skip item')
      setItems(data.items || [])
    } catch (error) {
      setError(String(error))
    }
  }

  const remaining = items.filter((item) =>
    ['pending', 'running', 'failed'].includes(item.status),
  )
  if (!remaining.length && !running && !error) return null
  const completed = items.filter((item) => item.status === 'completed').length
  const skipped = items.filter((item) => item.status === 'skipped').length
  return (
    <SettingsSection title="Capture missing webpage screenshots">
      <div className="space-y-3 py-4">
        <p className="text-sm" aria-live="polite">
          {remaining.length} remaining · {completed} captured · {skipped}{' '}
          skipped
        </p>
        <progress
          className="h-2 w-full accent-[var(--bladevault-gold)]"
          aria-label="Screenshot capture progress"
          max={items.length || 1}
          value={completed + skipped}
        />
        {current && (
          <p
            className="break-words text-sm text-muted-foreground"
            role="status"
          >
            Capturing {current}…
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Keep this Settings tab open while capturing. Stopping or leaving
          finishes the current item; completed work is saved and you can resume
          later.
        </p>
        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button
              variant="outline"
              onClick={() => {
                stop.current = true
                setCurrent((name) => `${name} — stopping after this item`)
              }}
            >
              Stop after current item
            </Button>
          ) : (
            <Button
              onClick={() => void run()}
              disabled={
                !items.some((item) =>
                  ['pending', 'failed'].includes(item.status),
                )
              }
            >
              {completed || items.some((item) => item.status === 'failed')
                ? 'Resume / retry missing screenshots'
                : 'Capture missing screenshots'}
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {items.some((item) => item.status === 'failed') && (
          <ul className="space-y-2">
            {items
              .filter((item) => item.status === 'failed')
              .map((item) => (
                <li
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm"
                >
                  <div className="min-w-0 break-words">
                    <p className="font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.error}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={running}
                    onClick={() => void skip(item.id)}
                  >
                    Skip
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  )
}
