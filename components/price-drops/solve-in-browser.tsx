'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { storeLabel } from './price-format'

export type SolveTarget = {
  sourceId: number
  url: string
  storeName: string
  /** 'blocked' means a bot check; other problems still benefit from a look. */
  status: string
}

type Phase = 'starting' | 'waiting' | 'saving' | 'done' | 'error'

/** Shown where the server cannot open a window the person can see. */
export const SOLVE_UNAVAILABLE_TEXT =
  'Solve in browser needs the desktop app or BladeVault running on this computer. On a Docker or Helm server the window would open where you cannot see it.'

let solveCapability: Promise<boolean> | null = null

function loadSolveCapability(): Promise<boolean> {
  solveCapability ??= fetch('/api/prices/capabilities', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('capabilities unavailable')
      const data = (await response.json()) as { solveInBrowser?: unknown }
      return data.solveInBrowser === true
    })
    .catch(() => {
      // Ask again next time; until then the buttons stay hidden.
      solveCapability = null
      return false
    })
  return solveCapability
}

/**
 * Whether this server can open a visible browser window: null while
 * unknown, then true or false. Asked once per page load.
 */
export function useSolveInBrowserAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadSolveCapability().then((value) => {
      if (!cancelled) setAvailable(value)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return available
}

async function postJson<T>(
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; data: T & { error?: string; code?: string } }> {
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string
    code?: string
  }
  return { ok: response.ok, data }
}

/**
 * Solve in browser: opens the store page in a visible browser window where
 * the person passes the bot check (or closes a pop-up) themselves. Done
 * keeps that window's cookies for the store and checks the price again.
 */
export function SolveInBrowserDialog({
  target,
  onClose,
  onSolved,
}: {
  target: SolveTarget | null
  onClose: () => void
  onSolved?: () => void
}) {
  // One session per opened target; a new target starts fresh.
  return target ? (
    <SolveSession
      key={target.sourceId}
      target={target}
      onClose={onClose}
      onSolved={onSolved}
    />
  ) : null
}

function SolveSession({
  target,
  onClose,
  onSolved,
}: {
  target: SolveTarget
  onClose: () => void
  onSolved?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [message, setMessage] = useState<string | null>(null)
  const session = useRef<string | null>(null)
  const sourceId = target.sourceId
  const url = target.url

  useEffect(() => {
    let cancelled = false
    void postJson<{ sessionId?: string }>('/api/scrape/interactive/start', {
      url,
    })
      .then(({ ok, data }) => {
        if (cancelled) {
          if (data.sessionId)
            void postJson(`/api/scrape/interactive/${data.sessionId}/cancel`)
          return
        }
        if (!ok || !data.sessionId) {
          setPhase('error')
          setMessage(data.error ?? 'Could not open the browser window.')
          return
        }
        session.current = data.sessionId
        setPhase('waiting')
      })
      .catch(() => {
        if (cancelled) return
        setPhase('error')
        setMessage('Could not open the browser window.')
      })
    return () => {
      cancelled = true
    }
  }, [sourceId, url])

  const close = () => {
    const id = session.current
    session.current = null
    if (id)
      void postJson(`/api/scrape/interactive/${id}/cancel`).catch(() => {})
    onClose()
  }

  const done = async () => {
    const id = session.current
    if (!id) return
    setPhase('saving')
    setMessage(null)
    try {
      const { ok, data } = await postJson(
        `/api/prices/sources/${sourceId}/solve`,
        { sessionId: id },
      )
      if (ok) {
        session.current = null
        setPhase('done')
        onSolved?.()
        return
      }
      if (data.code === 'challenge') {
        setPhase('waiting')
        setMessage(
          'The bot check is still on the page. Finish it in the browser window, then select Done again.',
        )
        return
      }
      if (data.code === 'session_expired') session.current = null
      setPhase(data.code === 'session_expired' ? 'error' : 'waiting')
      setMessage(data.error ?? 'Could not save the store session.')
    } catch {
      setPhase('waiting')
      setMessage('Could not save the store session.')
    }
  }

  const store = storeLabel(target.storeName)
  const blocked = target.status === 'blocked'
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent data-solve-in-browser={phase}>
        <DialogHeader>
          <DialogTitle>
            {blocked
              ? `Solve the bot check at ${store}`
              : `Fix ${store} in a browser`}
          </DialogTitle>
          <DialogDescription>
            {blocked
              ? 'The store asked BladeVault to prove it is a person. Pass the check yourself in the browser window; BladeVault then keeps the store’s cookies so later checks get through.'
              : 'Open the product page in a browser window to see what blocks the price, for example a cookie banner, an age prompt or a region choice. Settle it there, then select Done.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm" role="status">
          {phase === 'starting' ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Opening the browser window…
            </p>
          ) : phase === 'waiting' ? (
            <p>
              A browser window with the store page is open. When the product
              page shows its price, select <b>Done</b>.
            </p>
          ) : phase === 'saving' ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Saving the store session…
            </p>
          ) : phase === 'done' ? (
            <p>Saved. BladeVault is checking the price again now.</p>
          ) : null}
          {message ? (
            <p
              className={
                phase === 'error' ? 'text-destructive' : 'text-muted-foreground'
              }
            >
              {message}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {phase === 'done' || phase === 'error' ? (
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={phase !== 'waiting'}
                onClick={() => void done()}
              >
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
